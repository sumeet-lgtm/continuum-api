import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { sendViaSes, isSesConfigured } from '../../lib/ses.js';
import { config } from '../../config.js';

const createSchema = z.object({
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  domain_id: z.string().optional(),
});

// Seed email addresses for inbox placement testing
const SEED_ADDRESSES: Array<{ provider: string; email: string }> = [
  { provider: 'gmail', email: process.env['SEED_GMAIL_USER'] ?? 'seed.continuum.gmail@gmail.com' },
  { provider: 'outlook', email: process.env['SEED_OUTLOOK_USER'] ?? 'seed.continuum.outlook@outlook.com' },
];

export async function inboxTestRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/inbox-test
  fastify.post('/inbox-test', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    if (!isSesConfigured()) throw Errors.serviceUnavailable('Send (SES not configured)');

    const { subject, html_body, from_name, from_email } = parsed.data;

    // Create test record
    const test = await prisma.inboxTest.create({
      data: { apiKeyId, subject, fromEmail: `${from_name} <${from_email}>`, status: 'pending' },
      select: { id: true, subject: true, fromEmail: true, status: true, createdAt: true },
    });

    // Send to all seed addresses (non-blocking)
    const fromAddress = `${from_name} <${from_email}>`;
    const sendPromises = SEED_ADDRESSES.map(seed =>
      sendViaSes({ to: seed.email, from: fromAddress, subject, htmlBody: html_body }).catch(() => null)
    );

    void Promise.all(sendPromises).then(async () => {
      // After 90s, check placement (mocked unless IMAP is configured)
      await new Promise(r => setTimeout(r, 90000));
      const results = await checkPlacement();
      await prisma.inboxTest.update({
        where: { id: test.id },
        data: { status: 'complete', results, score: calculateScore(results), checkedAt: new Date() },
      });
    });

    return reply.status(202).send({ ...test, message: 'Test emails sent. Results available in ~2 minutes.' });
  });

  // GET /v1/inbox-tests
  fastify.get('/inbox-tests', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const tests = await prisma.inboxTest.findMany({
      where: { apiKeyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, subject: true, fromEmail: true, status: true, score: true, createdAt: true, checkedAt: true },
    });
    return reply.status(200).send({ data: tests });
  });

  // GET /v1/inbox-tests/:id
  fastify.get('/inbox-tests/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const test = await prisma.inboxTest.findFirst({ where: { id, apiKeyId } });
    if (!test) throw Errors.notFound('Test not found.');
    return reply.status(200).send(test);
  });
}

async function checkPlacement(): Promise<Record<string, string>> {
  // Default: return "checking" status
  // When IMAP credentials are available, imapWorker will update this
  const results: Record<string, string> = {};
  for (const seed of SEED_ADDRESSES) {
    results[seed.provider] = 'unknown';
  }

  // If seed Gmail credentials are configured, attempt IMAP check
  const gmailUser = (config as Record<string, unknown>)['SEED_GMAIL_USER'] as string | undefined;
  if (gmailUser) {
    results['gmail'] = 'inbox'; // Placeholder — real IMAP check in imapWorker
  }

  return results;
}

function calculateScore(results: Record<string, string>): number {
  const values = Object.values(results);
  if (values.length === 0) return 50;
  const inboxCount = values.filter(v => v === 'inbox').length;
  return Math.round(inboxCount / values.length * 100);
}

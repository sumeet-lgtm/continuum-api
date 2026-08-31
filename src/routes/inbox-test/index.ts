import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { sendViaSes, isSesConfigured } from '../../lib/ses.js';
import { checkInboxPlacement, type PlacementResult } from '../../lib/inboxPlacement.js';
import { config } from '../../config.js';

const createSchema = z.object({
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  domain_id: z.string().optional(),
});

// Seed email addresses for inbox placement testing. An address without a
// configured seed account falls back to a placeholder so the probe send
// still has somewhere to go — checkInboxPlacement() reports that provider
// as 'unavailable' rather than fabricating a placement for it.
const SEED_ADDRESSES: Array<{ provider: string; email: string }> = [
  { provider: 'gmail', email: config.SEED_GMAIL_USER ?? 'seed.continuum.gmail@gmail.com' },
  { provider: 'outlook', email: config.SEED_OUTLOOK_USER ?? 'seed.continuum.outlook@outlook.com' },
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

    // Send to all seed addresses (non-blocking). Each probe carries a
    // unique header so the placement check below can find this exact
    // message rather than guessing from timing/subject alone.
    const fromAddress = `${from_name} <${from_email}>`;
    const testMarker = randomUUID();
    const sendPromises = SEED_ADDRESSES.map(seed =>
      sendViaSes({
        to: seed.email, from: fromAddress, subject, htmlBody: html_body,
        headers: { 'X-Continuum-Test-Id': testMarker },
      }).catch(() => null)
    );

    void Promise.all(sendPromises).then(async () => {
      // Give the probe time to actually land before checking for it.
      await new Promise(r => setTimeout(r, 90000));
      const results = await checkInboxPlacement(testMarker);
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

// Score only counts providers that were actually checked — a provider with
// no seed account configured ('unavailable') or that errored out ('error')
// wasn't tested at all and shouldn't move the score in either direction.
export function calculateScore(results: Record<string, PlacementResult>): number | null {
  const checked = Object.values(results).filter((v) => v === 'inbox' || v === 'spam' || v === 'not_found');
  if (checked.length === 0) return null;
  const inboxCount = checked.filter((v) => v === 'inbox').length;
  return Math.round((inboxCount / checked.length) * 100);
}

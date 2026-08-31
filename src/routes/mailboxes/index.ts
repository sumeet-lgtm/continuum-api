import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { encryptValue } from '../../lib/crypto.js';
import { testSmtpConnection } from '../../lib/smtp.js';
import { testImapConnection } from '../../lib/imapHost.js';
import { config } from '../../config.js';
import { getMailboxLimit } from '../../plugins/usageMeter.js';

const createSchema = z.object({
  type: z.enum(['smtp', 'gmail', 'outlook']),
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).max(200),
  password: z.string().optional(),
  daily_limit: z.coerce.number().int().min(1).max(2000).default(200),
  send_delay_min_ms: z.coerce.number().int().min(1000).max(300000).default(30000),
  send_delay_max_ms: z.coerce.number().int().min(1000).max(600000).default(120000),
});

const warmupSchema = z.object({
  target_per_day: z.coerce.number().int().min(5).max(200).default(40),
  ramp_up_days: z.coerce.number().int().min(7).max(90).default(30),
  pool_tier: z.enum(['basic', 'standard', 'premium']).default('standard'),
});

function getMailboxSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

export async function mailboxRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/mailboxes
  fastify.post('/mailboxes', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { type, host, port, username, password, daily_limit, send_delay_min_ms, send_delay_max_ms } = parsed.data;

    // Enforce per-plan mailbox cap — advertised on the pricing page but
    // previously never checked here, unlike every other plan-gated resource.
    const mailboxLimit = getMailboxLimit(request.apiKey.plan);
    const existingCount = await prisma.mailbox.count({ where: { apiKeyId } });
    if (existingCount >= mailboxLimit) {
      throw Errors.validationFailed({
        limit: `Your ${request.apiKey.plan ?? 'free'} plan allows ${mailboxLimit} mailboxes. Delete some or upgrade to add more.`,
      });
    }

    const passwordEnc = password ? encryptValue(password, getMailboxSecret()) : null;

    const mailbox = await prisma.mailbox.create({
      data: {
        apiKeyId, type, host: host ?? null, port: port ?? null, username,
        passwordEnc, dailyLimit: daily_limit,
        sendDelayMinMs: send_delay_min_ms, sendDelayMaxMs: send_delay_max_ms,
        status: 'active',
      },
      select: { id: true, type: true, host: true, port: true, username: true, dailyLimit: true, status: true, createdAt: true },
    });
    return reply.status(201).send(mailbox);
  });

  // GET /v1/mailboxes
  fastify.get('/mailboxes', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const mailboxes = await prisma.mailbox.findMany({
      where: { apiKeyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, host: true, username: true, dailyLimit: true, sentToday: true, status: true, lastErrorMsg: true, warmupConfig: true, createdAt: true },
    });
    return reply.status(200).send({ data: mailboxes });
  });

  // GET /v1/mailboxes/:id
  fastify.get('/mailboxes/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({
      where: { id, apiKeyId },
      select: { id: true, type: true, host: true, port: true, username: true, dailyLimit: true, sentToday: true, sendDelayMinMs: true, sendDelayMaxMs: true, status: true, lastErrorMsg: true, lastCheckedAt: true, warmupConfig: true, createdAt: true },
    });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');
    return reply.status(200).send(mailbox);
  });

  // DELETE /v1/mailboxes/:id
  fastify.delete('/mailboxes/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({ where: { id, apiKeyId } });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');
    await prisma.mailbox.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });

  // POST /v1/mailboxes/:id/test
  fastify.post('/mailboxes/:id/test', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({ where: { id, apiKeyId } });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');

    if (!mailbox.host || !mailbox.passwordEnc) {
      await prisma.mailbox.update({ where: { id }, data: { status: 'error', lastErrorMsg: 'Missing host or credentials' } });
      return reply.status(200).send({ ok: false, error: 'Missing SMTP host or credentials' });
    }

    // Real SMTP connectivity test — required, this is what actually sends.
    const smtpResult = await testSmtpConnection({
      host: mailbox.host,
      port: mailbox.port ?? 587,
      username: mailbox.username,
      passwordEnc: mailbox.passwordEnc,
    });

    // IMAP is only needed for reply detection and warmup auto-open/reply —
    // check it too, but don't let a bad IMAP config mark an otherwise-working
    // sending mailbox as fully 'error'. Report both halves separately so the
    // dashboard can say exactly what won't work, instead of a mailbox looking
    // "active" while reply detection silently never fires.
    const imapResult = await testImapConnection({
      host: mailbox.host,
      username: mailbox.username,
      passwordEnc: mailbox.passwordEnc,
    });

    await prisma.mailbox.update({
      where: { id },
      data: {
        status: smtpResult.ok ? 'active' : 'error',
        lastErrorMsg: smtpResult.ok
          ? (imapResult.ok ? null : `SMTP ok, but IMAP failed (reply detection/warmup won't work): ${imapResult.error ?? 'unknown error'}`)
          : (smtpResult.error ?? 'SMTP test failed'),
        lastCheckedAt: new Date(),
      },
    });
    return reply.status(200).send({
      ok: smtpResult.ok,
      error: smtpResult.error,
      smtp: smtpResult,
      imap: imapResult,
    });
  });

  // POST /v1/mailboxes/:id/warmup — enable warmup
  fastify.post('/mailboxes/:id/warmup', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = warmupSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const mailbox = await prisma.mailbox.findFirst({ where: { id, apiKeyId } });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');

    const { target_per_day, ramp_up_days, pool_tier } = parsed.data;

    const warmup = await prisma.warmupConfig.upsert({
      where: { mailboxId: id },
      create: { mailboxId: id, enabled: true, targetPerDay: target_per_day, rampUpDays: ramp_up_days, poolTier: pool_tier },
      update: { enabled: true, targetPerDay: target_per_day, rampUpDays: ramp_up_days, poolTier: pool_tier },
    });
    return reply.status(200).send(warmup);
  });

  // DELETE /v1/mailboxes/:id/warmup — disable warmup
  fastify.delete('/mailboxes/:id/warmup', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({ where: { id, apiKeyId } });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');
    await prisma.warmupConfig.update({ where: { mailboxId: id }, data: { enabled: false } });
    return reply.status(200).send({ disabled: true });
  });

  // GET /v1/mailboxes/:id/warmup — warmup stats
  fastify.get('/mailboxes/:id/warmup', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({ where: { id, apiKeyId }, include: { warmupConfig: true } });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');
    if (!mailbox.warmupConfig) return reply.status(200).send({ enabled: false });

    const wc = mailbox.warmupConfig;
    const daysRunning = Math.floor((Date.now() - wc.startedAt.getTime()) / (1000 * 60 * 60 * 24));
    const progress = Math.min(100, Math.round(daysRunning / wc.rampUpDays * 100));
    const todayTarget = Math.min(wc.targetPerDay, Math.max(5, Math.round(5 + (wc.targetPerDay - 5) * daysRunning / wc.rampUpDays)));

    return reply.status(200).send({ ...wc, days_running: daysRunning, progress_pct: progress, today_target: todayTarget, sent_today: mailbox.sentToday });
  });
}

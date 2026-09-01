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
import { encryptOAuthToken } from '../../lib/oauth/tokens.js';
import { signOAuthState, verifyOAuthState } from '../../lib/oauth/state.js';
import { isGoogleOAuthConfigured, getGoogleAuthUrl, exchangeGoogleCode } from '../../lib/oauth/google.js';
import { isMicrosoftOAuthConfigured, getMicrosoftAuthUrl, exchangeMicrosoftCode } from '../../lib/oauth/microsoft.js';
import { logger } from '../../lib/logger.js';

const OAUTH_PROVIDER_DEFAULTS: Record<'google' | 'microsoft', { host: string; port: number }> = {
  google: { host: 'smtp.gmail.com', port: 587 },
  microsoft: { host: 'smtp.office365.com', port: 587 },
};

// Mailbox.type uses the same 'gmail'/'outlook' vocabulary as the manual
// connect form's createSchema below — 'google'/'microsoft' only exists as
// the OAuth *provider* identifier (URLs, scopes, which token endpoint to
// refresh against), so an OAuth- and manually-connected mailbox for the
// same real provider end up with the same type value.
const PROVIDER_TO_MAILBOX_TYPE: Record<'google' | 'microsoft', 'gmail' | 'outlook'> = {
  google: 'gmail',
  microsoft: 'outlook',
};

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
  // GET /v1/mailboxes/oauth/:provider/start — authenticated; returns the
  // provider's consent-screen URL for the dashboard to redirect the
  // browser to. Not a server-side redirect itself since this is behind the
  // same Bearer/API-key auth as every other route here — the browser needs
  // the URL to navigate to on its own.
  fastify.get<{ Params: { provider: string } }>(
    '/mailboxes/oauth/:provider/start',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
      const { provider } = request.params;
      const state = signOAuthState(request.apiKey.id);

      if (provider === 'google') {
        if (!isGoogleOAuthConfigured()) throw Errors.validationFailed({ provider: 'Google mailbox connect is not configured on this deployment yet.' });
        return reply.status(200).send({ url: getGoogleAuthUrl(state) });
      }
      if (provider === 'microsoft') {
        if (!isMicrosoftOAuthConfigured()) throw Errors.validationFailed({ provider: 'Microsoft mailbox connect is not configured on this deployment yet.' });
        return reply.status(200).send({ url: getMicrosoftAuthUrl(state) });
      }
      throw Errors.validationFailed({ provider: 'provider must be "google" or "microsoft"' });
    },
  );

  // GET /v1/mailboxes/oauth/:provider/callback — public; hit directly by
  // Google/Microsoft with only ?code&state, no auth header. Identity comes
  // from the signed state (see verifyOAuthState above), not requireAuth.
  fastify.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    '/mailboxes/oauth/:provider/callback',
    async (request: FastifyRequest<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>, reply: FastifyReply) => {
      const { provider } = request.params;
      const { code, state, error } = request.query;
      const dashboardUrl = `${config.DASHBOARD_URL}/dashboard/mailboxes`;

      if (error) return reply.redirect(`${dashboardUrl}?oauth_error=${encodeURIComponent(error)}`);
      if (!code || !state) return reply.redirect(`${dashboardUrl}?oauth_error=missing_code`);
      if (provider !== 'google' && provider !== 'microsoft') return reply.redirect(`${dashboardUrl}?oauth_error=unknown_provider`);

      const verified = verifyOAuthState(state);
      if (!verified) return reply.redirect(`${dashboardUrl}?oauth_error=invalid_or_expired_state`);

      try {
        const { refreshToken, email } = provider === 'google'
          ? await exchangeGoogleCode(code)
          : await exchangeMicrosoftCode(code);

        const oauthTokenEnc = encryptOAuthToken({ provider, refreshToken });
        const { host, port } = OAUTH_PROVIDER_DEFAULTS[provider];
        const mailboxType = PROVIDER_TO_MAILBOX_TYPE[provider];

        // Re-connecting the same provider account updates the existing
        // mailbox's token in place instead of creating a duplicate row.
        const existing = await prisma.mailbox.findFirst({
          where: { apiKeyId: verified.apiKeyId, type: mailboxType, username: email },
        });

        if (existing) {
          await prisma.mailbox.update({
            where: { id: existing.id },
            data: { oauthTokenEnc, passwordEnc: null, status: 'active', lastErrorMsg: null, host, port },
          });
        } else {
          // No requireAuth on this route (see comment above) — request.apiKey
          // isn't populated, so the plan has to be looked up directly.
          const apiKeyRecord = await prisma.apiKey.findUnique({ where: { id: verified.apiKeyId }, select: { plan: true } });
          const mailboxLimit = getMailboxLimit(apiKeyRecord?.plan ?? null);
          const existingCount = await prisma.mailbox.count({ where: { apiKeyId: verified.apiKeyId } });
          if (existingCount >= mailboxLimit) {
            return reply.redirect(`${dashboardUrl}?oauth_error=mailbox_limit_reached`);
          }
          await prisma.mailbox.create({
            data: {
              apiKeyId: verified.apiKeyId, type: mailboxType, username: email,
              oauthTokenEnc, host, port, status: 'active',
            },
          });
        }

        return reply.redirect(`${dashboardUrl}?connected=${provider}`);
      } catch (err) {
        logger.error({ err, provider }, 'OAuth mailbox connect failed');
        return reply.redirect(`${dashboardUrl}?oauth_error=connect_failed`);
      }
    },
  );

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
      select: { id: true, type: true, host: true, username: true, dailyLimit: true, sentToday: true, status: true, lastErrorMsg: true, warmupConfig: true, createdAt: true, oauthTokenEnc: true },
    });
    // oauthTokenEnc is an encrypted blob — never send it to the client, only
    // whether one exists, so the dashboard knows to hide the password field.
    const data = mailboxes.map(({ oauthTokenEnc, ...rest }) => ({ ...rest, connectedViaOAuth: oauthTokenEnc !== null }));
    return reply.status(200).send({ data });
  });

  // GET /v1/mailboxes/:id
  fastify.get('/mailboxes/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const mailbox = await prisma.mailbox.findFirst({
      where: { id, apiKeyId },
      select: { id: true, type: true, host: true, port: true, username: true, dailyLimit: true, sentToday: true, sendDelayMinMs: true, sendDelayMaxMs: true, status: true, lastErrorMsg: true, lastCheckedAt: true, warmupConfig: true, createdAt: true, oauthTokenEnc: true },
    });
    if (!mailbox) throw Errors.notFound('Mailbox not found.');
    const { oauthTokenEnc, ...rest } = mailbox;
    return reply.status(200).send({ ...rest, connectedViaOAuth: oauthTokenEnc !== null });
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

    if (!mailbox.host || !(mailbox.passwordEnc || mailbox.oauthTokenEnc)) {
      await prisma.mailbox.update({ where: { id }, data: { status: 'error', lastErrorMsg: 'Missing host or credentials' } });
      return reply.status(200).send({ ok: false, error: 'Missing SMTP host or credentials' });
    }

    // Real SMTP connectivity test — required, this is what actually sends.
    const smtpResult = await testSmtpConnection({
      host: mailbox.host,
      port: mailbox.port ?? 587,
      username: mailbox.username,
      passwordEnc: mailbox.passwordEnc,
      oauthTokenEnc: mailbox.oauthTokenEnc,
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
      oauthTokenEnc: mailbox.oauthTokenEnc,
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

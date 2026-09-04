import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { config, isDev, isTest } from './config.js';
import { logger } from './lib/logger.js';
import { redactUrl } from './lib/redact.js';
import { initSentry, installCrashReporting } from './lib/sentry.js';

initSentry('api');
installCrashReporting('api');
import { prisma, disconnectPrisma } from './lib/prisma.js';
import { closeQueues } from './lib/queue.js';
import { authPlugin } from './plugins/auth.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { errorHandler } from './plugins/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { verifySingleRoute } from './routes/verify/single.js';
import { verifyPublicRoute } from './routes/verify/public.js';
import { monitoringRoutes } from './routes/monitor/index.js';
import { historyRoutes } from './routes/history/index.js';
import { webhookRoutes } from './routes/webhooks/index.js';
import { bulkJobRoutes } from './routes/bulk-jobs/index.js';
import { billingRoutes } from './routes/billing/index.js';
import { sendRoute } from './routes/send/index.js';
import { sendEventsRoute } from './routes/send/events.js';
import { batchSendRoute } from './routes/send/batch.js';
import { suppressionRoutes } from './routes/suppressions/index.js';
import { messagesRoutes } from './routes/messages/index.js';
import { usageRoutes } from './routes/usage/index.js';
import { apiKeyRoutes } from './routes/api-keys/index.js';
import { accountRoutes } from './routes/account/index.js';
import { domainRoutes } from './routes/domains/index.js';
import { templateRoutes } from './routes/templates/index.js';
import { unsubscribeRoutes } from './routes/unsubscribe/index.js';
import { preferencesRoutes } from './routes/preferences/index.js';
import { trackRoutes } from './routes/track/index.js';
import { analyticsRoutes } from './routes/analytics/index.js';
import { listRoutes } from './routes/lists/index.js';
import { contactRoutes } from './routes/contacts/index.js';
import { segmentRoutes } from './routes/segments/index.js';
import { campaignRoutes } from './routes/campaigns/index.js';
import { mailboxRoutes } from './routes/mailboxes/index.js';
import { sequenceRoutes } from './routes/sequences/index.js';
import { leadRoutes } from './routes/leads/index.js';
import { accountsRoutes } from './routes/accounts/index.js';
import { brandRoutes } from './routes/brand/index.js';
import { finderRoutes } from './routes/finder/index.js';
import { inboxRoutes } from './routes/inbox/index.js';
import { inboxTestRoutes } from './routes/inbox-test/index.js';
import { aiRoutes } from './routes/ai/index.js';
import { mcpRoutes } from './routes/mcp/index.js';
import { connectorRoutes } from './routes/connectors/index.js';
import { paymentConnectorRoutes } from './routes/connectors/payment.js';
import { teamRoutes } from './routes/team/index.js';
import { automationRoutes } from './routes/automations/index.js';
import { toolRoutes } from './routes/tools/index.js';
import { logsRoutes } from './routes/logs/index.js';
import { privacyRoutes } from './routes/privacy/index.js';
import { authRoutes } from './routes/auth/index.js';
import { calcomWebhookRoutes } from './routes/webhooks/calcom.js';
import { workosWebhookRoutes } from './routes/webhooks/workos.js';
import { orgRoutes } from './routes/org/index.js';
import { loadDisposableList } from './engine/disposable.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use our own pino instance
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => crypto.randomUUID(),
    trustProxy: true, // Required for correct IP detection behind load balancers
    bodyLimit: 52428800, // 50MB body limit for large CSV uploads
    ajv: {
      customOptions: {
        removeAdditional: 'all', // Strip unknown fields from validated bodies
        useDefaults: true,
        coerceTypes: 'array',
        allErrors: false, // Fail fast on first validation error
      },
    },
  });

  // ─── CVE-2026-25223 mitigation (GHSA-jx2c-rxcm-jvmq) ───────────────────────
  // A tab character in Content-Type (e.g. "application/json\ta") bypasses
  // Fastify's body-validation schema selection while the body still parses
  // as the original type — Fastify's own recommended workaround pending the
  // 5.7.2+ upgrade this project hasn't taken yet.
  app.addHook('onRequest', async (request, reply) => {
    const contentType = request.headers['content-type'];
    if (contentType?.includes('\t')) {
      return reply.status(400).send({ error: 'Invalid Content-Type header' });
    }
  });

  // ─── Request/response logging ──────────────────────────────────────────────
  app.addHook('onRequest', async (request) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: redactUrl(request.url),
        ip: request.ip,
      },
      'Incoming request',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: redactUrl(request.url),
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request complete',
    );

    // Best-effort API request log — only for authenticated /v1/* calls.
    // Fire-and-forget: never awaited, never throws to the caller.
    const apiKey = (request as typeof request & { apiKey?: { id: string } }).apiKey;
    if (apiKey?.id && request.url.startsWith('/v1/') && !request.url.startsWith('/v1/logs')) {
      const path = request.url.split('?')[0] ?? request.url;
      // Collapse dynamic segments: /v1/verify/:id → /v1/verify/*
      const cleanPath = path.replace(/\/[a-z0-9_-]{20,}/gi, '/*');
      prisma.apiRequestLog.create({
        data: {
          apiKeyId:   apiKey.id,
          method:     request.method,
          path:       cleanPath,
          statusCode: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
          sourceIp:   request.ip ?? null,
          requestId:  request.id ?? null,
        },
      }).catch(() => { /* best-effort — discard on error */ });
    }
  });

  // ─── Security headers ──────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // API — no HTML served
  });

  // ─── CORS ─────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: isDev ? true : (config.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ?? false),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-ID',
    ],
    credentials: false,
  });

  // ─── Multipart (CSV uploads) ───────────────────────────────────────────────
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB max upload
      files: 1, // One file per request
      fields: 5,
    },
  });

  // ─── Application plugins ───────────────────────────────────────────────────
  // Order matters: errorHandler → auth → rateLimit
  await app.register(errorHandler);
  await app.register(authPlugin);
  await app.register(rateLimitPlugin);

  // ─── Routes ───────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(verifySingleRoute, { prefix: '/v1' });
  await app.register(verifyPublicRoute, { prefix: '/v1' });
  await app.register(monitoringRoutes, { prefix: '/v1' });
  await app.register(historyRoutes, { prefix: '/v1' });
  await app.register(webhookRoutes, { prefix: '/v1' });
  await app.register(bulkJobRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(sendRoute, { prefix: '/v1' });
  await app.register(sendEventsRoute, { prefix: '/v1' });
  await app.register(batchSendRoute, { prefix: '/v1' });
  await app.register(suppressionRoutes, { prefix: '/v1' });
  await app.register(messagesRoutes, { prefix: '/v1' });
  await app.register(usageRoutes, { prefix: '/v1' });
  await app.register(apiKeyRoutes, { prefix: '/v1' });
  await app.register(accountRoutes, { prefix: '/v1' });
  await app.register(domainRoutes, { prefix: '/v1' });
  await app.register(templateRoutes, { prefix: '/v1' });
  await app.register(analyticsRoutes, { prefix: '/v1' });
  await app.register(listRoutes, { prefix: '/v1' });
  await app.register(contactRoutes, { prefix: '/v1' });
  await app.register(segmentRoutes, { prefix: '/v1' });
  await app.register(campaignRoutes, { prefix: '/v1' });
  await app.register(mailboxRoutes, { prefix: '/v1' });
  await app.register(sequenceRoutes, { prefix: '/v1' });
  await app.register(leadRoutes, { prefix: '/v1' });
  await app.register(accountsRoutes, { prefix: '/v1' });
  await app.register(brandRoutes, { prefix: '/v1' });
  await app.register(finderRoutes, { prefix: '/v1' });
  await app.register(inboxRoutes, { prefix: '/v1' });
  await app.register(inboxTestRoutes, { prefix: '/v1' });
  await app.register(aiRoutes, { prefix: '/v1' });
  await app.register(automationRoutes, { prefix: '/v1' });
  await app.register(toolRoutes, { prefix: '/v1' });
  await app.register(logsRoutes, { prefix: '/v1' });
  await app.register(privacyRoutes, { prefix: '/v1' });
  await app.register(connectorRoutes, { prefix: '/v1' });
  await app.register(paymentConnectorRoutes, { prefix: '/v1' });
  await app.register(teamRoutes, { prefix: '/v1' });
  // MCP at root (no /v1 prefix — standard MCP endpoint is /mcp)
  await app.register(mcpRoutes);
  // Auth at /auth (no /v1 prefix — SSO redirects can't be versioned)
  await app.register(authRoutes);
  // Cal.com booking webhook at root (no /v1 — Cal.com hits this directly)
  await app.register(calcomWebhookRoutes);
  // WorkOS SCIM/org webhooks
  await app.register(workosWebhookRoutes);
  // Organization management (session JWT auth)
  await app.register(orgRoutes);
  // Tracking + unsubscribe at root (no /v1 — links in emails go here)
  await app.register(trackRoutes);
  await app.register(unsubscribeRoutes, { prefix: '/v1' });
  await app.register(preferencesRoutes, { prefix: '/v1' });

  // ─── Root info ────────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {
    return reply.send({
      name: 'Continuum API',
      version: process.env['npm_package_version'] ?? '0.1.0',
      // Set via `railway variable set COMMIT_SHA=$(git rev-parse --short HEAD)
      // --skip-deploys` immediately before each `railway up` — deploys go
      // through the CLI, not a GitHub-connected pipeline, so Railway's
      // auto-injected RAILWAY_GIT_COMMIT_SHA is never populated here. Exists
      // so "is my latest deploy actually live" has a real answer instead of
      // inference from container uptime.
      commit: process.env['COMMIT_SHA'] ?? 'unknown',
      docs: 'https://github.com/your-org/continuum#readme',
      health: '/health',
    });
  });

  return app;
}

async function start(): Promise<void> {
  let app: FastifyInstance | null = null;

  // Pre-load the disposable domain blocklist before accepting any requests.
  // This is idempotent — safe to call here and in workers.
  loadDisposableList();

  try {
    app = await buildApp();

    await app.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info(
      { port: config.PORT, host: config.HOST, env: config.NODE_ENV },
      'Continuum API started',
    );

    // Warn if SES credentials are present but configuration set is missing —
    // bounces and complaints will still arrive via SNS, but SES won't apply
    // dedicated IP pool settings or suppression list rules without it.
    if (config.AWS_ACCESS_KEY_ID && !config.SES_CONFIGURATION_SET) {
      logger.warn('SES_CONFIGURATION_SET is not set — SES will send without a configuration set (bounce/complaint tracking via SNS still works, but dedicated IP pools and suppression list rules will not apply)');
    }
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');

    try {
      if (app) {
        // Stop accepting new connections; wait for in-flight requests to complete
        await app.close();
        logger.info('Fastify server closed');
      }

      // Close database and queue connections
      await Promise.allSettled([
        disconnectPrisma().then(() => logger.info('Prisma disconnected')),
        closeQueues().then(() => logger.info('BullMQ queues closed')),
      ]);

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // unhandledRejection/uncaughtException are handled by
  // installCrashReporting('api') above, at module load — installed once
  // before start() even runs, so a crash during startup is covered too.
}

// Export for testing
export { buildApp };

// Start when run directly — not under test. Integration tests import
// buildApp() from this module to get a testable Fastify instance, and with
// isolate:true every test file gets a fresh module registry, so without
// this guard each of those files would also trigger a real listen() on the
// same port, colliding across parallel workers and exiting the process.
if (!isTest) void start();

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { config, isDev } from './config.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { closeQueues } from './lib/queue.js';
import { authPlugin } from './plugins/auth.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';
import { errorHandler } from './plugins/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { verifySingleRoute } from './routes/verify/single.js';
import { monitoringRoutes } from './routes/monitor/index.js';
import { historyRoutes } from './routes/history/index.js';
import { webhookRoutes } from './routes/webhooks/index.js';
import { bulkJobRoutes } from './routes/bulk-jobs/index.js';
import { ipRoutes } from './routes/ip/index.js';
import { phoneRoutes } from './routes/phone/index.js';
import { billingRoutes } from './routes/billing/index.js';
import { sendRoute } from './routes/send/index.js';
import { sendEventsRoute } from './routes/send/events.js';
import { batchSendRoute } from './routes/send/batch.js';
import { suppressionRoutes } from './routes/suppressions/index.js';
import { messagesRoutes } from './routes/messages/index.js';
import { usageRoutes } from './routes/usage/index.js';
import { apiKeyRoutes } from './routes/api-keys/index.js';
import { domainRoutes } from './routes/domains/index.js';
import { templateRoutes } from './routes/templates/index.js';
import { unsubscribeRoutes } from './routes/unsubscribe/index.js';
import { trackRoutes } from './routes/track/index.js';
import { analyticsRoutes } from './routes/analytics/index.js';
import { listRoutes } from './routes/lists/index.js';
import { contactRoutes } from './routes/contacts/index.js';
import { segmentRoutes } from './routes/segments/index.js';
import { campaignRoutes } from './routes/campaigns/index.js';
import { mailboxRoutes } from './routes/mailboxes/index.js';
import { sequenceRoutes } from './routes/sequences/index.js';
import { leadRoutes } from './routes/leads/index.js';
import { inboxRoutes } from './routes/inbox/index.js';
import { inboxTestRoutes } from './routes/inbox-test/index.js';
import { aiRoutes } from './routes/ai/index.js';
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

  // ─── Request/response logging ──────────────────────────────────────────────
  app.addHook('onRequest', async (request) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
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
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request complete',
    );
  });

  // ─── Security headers ──────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // API — no HTML served
  });

  // ─── CORS ─────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: isDev ? true : process.env['ALLOWED_ORIGINS']?.split(',') ?? false,
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
  await app.register(monitoringRoutes, { prefix: '/v1' });
  await app.register(historyRoutes, { prefix: '/v1' });
  await app.register(webhookRoutes, { prefix: '/v1' });
  await app.register(bulkJobRoutes, { prefix: '/v1' });
  await app.register(ipRoutes, { prefix: '/v1' });
  await app.register(phoneRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(sendRoute, { prefix: '/v1' });
  await app.register(sendEventsRoute, { prefix: '/v1' });
  await app.register(batchSendRoute, { prefix: '/v1' });
  await app.register(suppressionRoutes, { prefix: '/v1' });
  await app.register(messagesRoutes, { prefix: '/v1' });
  await app.register(usageRoutes, { prefix: '/v1' });
  await app.register(apiKeyRoutes, { prefix: '/v1' });
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
  await app.register(inboxRoutes, { prefix: '/v1' });
  await app.register(inboxTestRoutes, { prefix: '/v1' });
  await app.register(aiRoutes, { prefix: '/v1' });
  // Tracking + unsubscribe at root (no /v1 — links in emails go here)
  await app.register(trackRoutes);
  await app.register(unsubscribeRoutes, { prefix: '/v1' });

  // ─── Root info ────────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {
    return reply.send({
      name: 'Continuum API',
      version: process.env['npm_package_version'] ?? '0.1.0',
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

  // Catch unhandled promise rejections — log and exit rather than silently corrupting state
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — exiting');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

// Export for testing
export { buildApp };

// Start when run directly
void start();

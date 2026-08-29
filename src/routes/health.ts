import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { pingRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  timestamp: string;
  checks: {
    database: CheckResult;
    redis: CheckResult;
  };
}

interface CheckResult {
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err }, 'Health check: database ping failed');
    return { status: 'error', latencyMs: Date.now() - start, error: message };
  }
}

const healthBodySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
    version: { type: 'string' },
    uptime: { type: 'number' },
    timestamp: { type: 'string' },
    checks: {
      type: 'object',
      properties: {
        database: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            latencyMs: { type: 'number' },
            error: { type: 'string' },
          },
        },
        redis: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            latencyMs: { type: 'number' },
            error: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const ok = await pingRedis();
    if (!ok) {
      return { status: 'error', latencyMs: Date.now() - start, error: 'Ping returned non-PONG' };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err }, 'Health check: Redis ping failed');
    return { status: 'error', latencyMs: Date.now() - start, error: message };
  }
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /health — full liveness + dependency check
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        // Same body shape on both — 503 fires when fully down (see handler).
        response: { 200: healthBodySchema, 503: healthBodySchema },
      },
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

      const allOk = database.status === 'ok' && redis.status === 'ok';
      const anyOk = database.status === 'ok' || redis.status === 'ok';

      const overallStatus: HealthStatus['status'] = allOk
        ? 'ok'
        : anyOk
          ? 'degraded'
          : 'error';

      const body: HealthStatus = {
        status: overallStatus,
        version: process.env['npm_package_version'] ?? '0.1.0',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        checks: { database, redis },
      };

      // Return 200 even when degraded — load balancers should keep routing
      // Return 503 only when fully down
      const statusCode = overallStatus === 'error' ? 503 : 200;
      return reply.status(statusCode).send(body);
    },
  );

  // GET /health/live — minimal Kubernetes liveness probe (no dependency checks)
  fastify.get(
    '/health/live',
    async (_request, reply) => {
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // GET /health/ready — readiness probe (checks DB + Redis)
  fastify.get(
    '/health/ready',
    async (_request, reply) => {
      const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

      if (database.status === 'error' || redis.status === 'error') {
        return reply.status(503).send({
          status: 'not_ready',
          checks: { database, redis },
        });
      }

      return reply.status(200).send({ status: 'ready' });
    },
  );
}

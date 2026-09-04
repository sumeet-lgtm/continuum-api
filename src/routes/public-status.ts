import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { pingRedis } from '../lib/redis.js';
import { getSesHealth } from '../lib/ses.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Public status endpoint — no auth required.
// Called by status.continuumapi.com / continuumapi.com/status.

async function dbCheck(): Promise<{ status: 'ok' | 'error'; latencyMs: number }> {
  const t = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - t };
  } catch {
    return { status: 'error', latencyMs: Date.now() - t };
  }
}

async function redisCheck(): Promise<{ status: 'ok' | 'error'; latencyMs: number }> {
  const t = Date.now();
  try {
    const ok = await pingRedis();
    return { status: ok ? 'ok' : 'error', latencyMs: Date.now() - t };
  } catch {
    return { status: 'error', latencyMs: Date.now() - t };
  }
}

// SES account check — 'not_configured' reads as operational on the status
// page (nothing to be down yet) rather than a false outage.
async function emailCheck(): Promise<{ status: 'ok' | 'error'; latencyMs: number | null }> {
  const t = Date.now();
  const health = await getSesHealth();
  if (health.status === 'error') {
    logger.warn({ detail: health.detail }, 'SES health check failed');
  }
  return {
    status: health.status === 'error' ? 'error' : 'ok',
    latencyMs: health.status === 'not_configured' ? null : Date.now() - t,
  };
}

// Live reachability check for the dashboard SPA — a short-timeout HEAD
// request, not a deep check, just "is app.continuumapi.com answering".
async function dashboardCheck(): Promise<{ status: 'ok' | 'error'; latencyMs: number | null }> {
  const t = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(config.DASHBOARD_URL, { method: 'HEAD', signal: controller.signal }).finally(() => clearTimeout(timeout));
    return { status: res.ok ? 'ok' : 'error', latencyMs: Date.now() - t };
  } catch {
    return { status: 'error', latencyMs: Date.now() - t };
  }
}

// Compute per-day error rate for the last N days from api_request_logs.
// Returns array of { date: 'YYYY-MM-DD', uptime: 0-100 } newest last.
async function computeDailyUptime(days: number): Promise<Array<{ date: string; uptime: number }>> {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await prisma.$queryRaw<
      Array<{ day: string; total: bigint; errors: bigint }>
    >`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)                             AS total,
        COUNT(*) FILTER (WHERE status_code >= 500) AS errors
      FROM api_request_logs
      WHERE created_at >= ${since}
      GROUP BY day
      ORDER BY day ASC
    `;

    // Build a full 90-day map (missing days = 100% uptime, no traffic)
    const map = new Map<string, number>();
    for (const r of rows) {
      const total = Number(r.total);
      const errors = Number(r.errors);
      map.set(r.day, total === 0 ? 100 : Math.max(0, 100 - (errors / total) * 100));
    }

    const result: Array<{ date: string; uptime: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10)!;
      result.push({ date: key, uptime: map.get(key) ?? 100 });
    }
    return result;
  } catch {
    // If DB is down, return empty — caller handles gracefully
    return [];
  }
}

export async function publicStatusRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/public/status — unauthenticated, CORS-open, cached 30s
  fastify.get('/v1/public/status', {}, async (_request, reply) => {
    const [[db, redis, email, dashboard], dailyUptime] = await Promise.all([
      Promise.all([dbCheck(), redisCheck(), emailCheck(), dashboardCheck()]),
      computeDailyUptime(90),
    ]);

    // Overall banner reflects the core API path (db/redis). Email delivery
    // and the dashboard are reported per-component below but don't flip the
    // top banner to "outage" on their own — a paused SES account or a slow
    // dashboard deploy isn't the same severity as the API being down.
    const allOk = db.status === 'ok' && redis.status === 'ok';
    const anyOk = db.status === 'ok' || redis.status === 'ok';
    const overall = allOk ? 'operational' : anyOk ? 'degraded' : 'outage';

    // Rolling 90-day uptime average
    const avg90 = dailyUptime.length === 0
      ? 100
      : dailyUptime.reduce((s, d) => s + d.uptime, 0) / dailyUptime.length;

    reply.header('Cache-Control', 'public, max-age=30');
    reply.header('Access-Control-Allow-Origin', '*');

    return reply.send({
      status: overall,
      timestamp: new Date().toISOString(),
      components: [
        { id: 'api',      name: 'API',            status: overall,                                          latencyMs: db.latencyMs },
        { id: 'database', name: 'Database',        status: db.status === 'ok' ? 'operational' : 'outage',    latencyMs: db.latencyMs },
        { id: 'queue',    name: 'Queue / Cache',   status: redis.status === 'ok' ? 'operational' : 'outage', latencyMs: redis.latencyMs },
        { id: 'email',    name: 'Email Delivery',  status: email.status === 'ok' ? 'operational' : 'outage', latencyMs: email.latencyMs },
        { id: 'dashboard',name: 'Dashboard',       status: dashboard.status === 'ok' ? 'operational' : 'outage', latencyMs: dashboard.latencyMs },
      ],
      uptime90: Math.round(avg90 * 100) / 100,
      days: dailyUptime.map((d) => ({
        date: d.date,
        status: d.uptime >= 99 ? 'ok' : d.uptime >= 90 ? 'degraded' : 'error',
      })),
      incidents: [],
    });
  });

  // POST /v1/status/subscribe — store email for status notifications
  fastify.post('/v1/status/subscribe', {
    schema: {
      body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
    },
  }, async (request, reply) => {
    const { email } = request.body as { email: string };
    try {
      await prisma.$executeRaw`
        INSERT INTO status_subscribers (email, created_at)
        VALUES (${email}, NOW())
        ON CONFLICT (email) DO NOTHING
      `;
    } catch (err) {
      // Only the migration-not-applied-yet case is safe to swallow —
      // anything else (bad connection, constraint violation, etc.) must
      // surface as a real error, or subscribers silently vanish with no
      // way for us to ever notice. Postgres reports a missing relation as
      // error code 42P01.
      const code = (err as { code?: string; meta?: { code?: string } } | null)?.code
        ?? (err as { meta?: { code?: string } } | null)?.meta?.code;
      const message = err instanceof Error ? err.message : '';
      const tableMissing = code === '42P01' || message.includes('does not exist');
      if (!tableMissing) {
        logger.error({ err }, 'status_subscribers insert failed');
        return reply.status(500).send({ ok: false, error: 'Could not save subscription — try again shortly.' });
      }
      logger.warn('status_subscribers table missing — migration not yet applied, subscription not saved');
      return reply.status(503).send({ ok: false, error: 'Subscriptions are not enabled yet — try again later.' });
    }
    return reply.send({ ok: true });
  });
}

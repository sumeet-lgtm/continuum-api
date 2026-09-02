import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';

interface LogsQuery {
  method?: string;
  path?: string;
  status?: string;  // "success" | "error" | "all"
  page?: string;
  limit?: string;
}

export async function logsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/logs — paginated request log for the authenticated key
  fastify.get(
    '/logs',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as LogsQuery;
      const page  = Math.max(1, parseInt(q.page  ?? '1',   10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50',  10)));
      const skip  = (page - 1) * limit;

      const where: Record<string, unknown> = { apiKeyId: request.apiKey.id };

      if (q.method && ['GET','POST','PATCH','DELETE'].includes(q.method.toUpperCase())) {
        where.method = q.method.toUpperCase();
      }
      if (q.path) {
        where.path = { startsWith: q.path };
      }
      if (q.status === 'success') {
        where.statusCode = { gte: 200, lt: 300 };
      } else if (q.status === 'error') {
        where.statusCode = { gte: 400 };
      }

      const [items, total] = await Promise.all([
        prisma.apiRequestLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            method: true,
            path: true,
            statusCode: true,
            durationMs: true,
            sourceIp: true,
            requestId: true,
            errorCode: true,
            createdAt: true,
          },
        }),
        prisma.apiRequestLog.count({ where }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/logs/summary — quick aggregate stats for the last 24h
  fastify.get(
    '/logs/summary',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const rows = await prisma.apiRequestLog.findMany({
        where: { apiKeyId, createdAt: { gte: since } },
        select: { statusCode: true, durationMs: true, path: true },
      });

      const total    = rows.length;
      const success  = rows.filter(r => r.statusCode >= 200 && r.statusCode < 300).length;
      const errors   = rows.filter(r => r.statusCode >= 400).length;
      const avgMs    = total > 0 ? Math.round(rows.reduce((s, r) => s + r.durationMs, 0) / total) : 0;
      const p99Ms    = total > 0
        ? rows.map(r => r.durationMs).sort((a, b) => a - b)[Math.floor(total * 0.99)] ?? 0
        : 0;

      // Top endpoints by volume
      const pathCounts: Record<string, number> = {};
      for (const r of rows) {
        pathCounts[r.path] = (pathCounts[r.path] ?? 0) + 1;
      }
      const topEndpoints = Object.entries(pathCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([path, count]) => ({ path, count }));

      return reply.status(200).send({
        window: '24h',
        total,
        success,
        errors,
        error_rate: total > 0 ? +((errors / total) * 100).toFixed(1) : 0,
        avg_ms: avgMs,
        p99_ms: p99Ms,
        top_endpoints: topEndpoints,
      });
    },
  );
}

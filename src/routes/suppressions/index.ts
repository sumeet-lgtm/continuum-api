import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const addSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()),
  reason: z.enum(['manual']).default('manual'),
});

export async function suppressionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/suppressions
  fastify.get(
    '/suppressions',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { reason?: string; page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const where = q.reason ? { reason: q.reason as never } : {};

      const [items, total] = await Promise.all([
        prisma.suppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, email: true, reason: true, createdAt: true, apiKeyId: true },
        }),
        prisma.suppression.count({ where }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // POST /v1/suppressions
  fastify.post(
    '/suppressions',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = addSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { email } = parsed.data;
      const apiKeyId = request.apiKey.id;

      const record = await prisma.suppression.upsert({
        where: { email },
        create: { email, reason: 'manual', apiKeyId },
        update: { reason: 'manual', apiKeyId },
        select: { id: true, email: true, reason: true, createdAt: true },
      });

      return reply.status(201).send(record);
    },
  );

  // DELETE /v1/suppressions/:email
  fastify.delete(
    '/suppressions/:email',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { email } = request.params as { email: string };
      const decoded = decodeURIComponent(email).trim().toLowerCase();

      const existing = await prisma.suppression.findUnique({ where: { email: decoded } });
      if (!existing) throw Errors.notFound('Suppression entry not found.');

      await prisma.suppression.delete({ where: { email: decoded } });
      return reply.status(200).send({ deleted: true, email: decoded });
    },
  );
}

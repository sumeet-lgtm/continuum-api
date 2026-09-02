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
  //
  // Previously had no apiKeyId filter at all — every customer got the
  // entire platform-wide suppression list, including which OTHER
  // customer's apiKeyId caused each entry. Scoped to entries this key
  // caused plus unattributed ones (a bounce/complaint whose originating
  // send couldn't be resolved to a key) — never another named customer's
  // entries. apiKeyId is no longer returned at all; a customer's own key
  // is redundant to echo back, and it's the exact field that was leaking.
  fastify.get(
    '/suppressions',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { reason?: string; page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const where = {
        ...(q.reason ? { reason: q.reason as never } : {}),
        OR: [{ apiKeyId: request.apiKey.id }, { apiKeyId: null }],
      };

      const [items, total] = await Promise.all([
        prisma.suppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, email: true, reason: true, createdAt: true },
        }),
        prisma.suppression.count({ where }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/suppressions/export — stream all suppressions for this key as CSV
  fastify.get(
    '/suppressions/export',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const where = { OR: [{ apiKeyId }, { apiKeyId: null }] };

      const date = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="suppressions-${date}.csv"`);

      let offset = 0;
      const batchSize = 1000;
      let csv = 'email,reason,added_at\n';

      while (true) {
        const batch = await prisma.suppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: batchSize,
          select: { email: true, reason: true, createdAt: true },
        });
        if (batch.length === 0) break;
        for (const row of batch) {
          const email = row.email.includes(',') ? `"${row.email}"` : row.email;
          csv += `${email},${row.reason},${row.createdAt.toISOString()}\n`;
        }
        offset += batch.length;
        if (batch.length < batchSize) break;
      }

      return reply.status(200).send(csv);
    },
  );

  // POST /v1/suppressions
  //
  // Was a global upsert keyed only on email — a second customer adding an
  // address someone else had already suppressed silently reassigned that
  // record's apiKeyId to themselves, hijacking ownership of another
  // customer's suppression entry. Now: if it's already suppressed by
  // anyone, this is a no-op that returns the existing (unowned-looking)
  // record rather than taking it over; only a genuinely new address
  // creates a row owned by this key. Enforcement (blocking a send) stays
  // global regardless of who added it — a real bounce/complaint/opt-out
  // should hold platform-wide, not just for the customer who caused it.
  fastify.post(
    '/suppressions',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = addSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { email } = parsed.data;
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.suppression.findUnique({ where: { email } });
      if (existing) {
        return reply.status(200).send({
          id: existing.id, email: existing.email, reason: existing.reason, createdAt: existing.createdAt,
        });
      }

      const record = await prisma.suppression.create({
        data: { email, reason: 'manual', apiKeyId },
        select: { id: true, email: true, reason: true, createdAt: true },
      });

      return reply.status(201).send(record);
    },
  );

  // DELETE /v1/suppressions/:email
  //
  // Was a global delete keyed only on email — any authenticated customer
  // could remove ANY other customer's suppression entry, including
  // reversing a real unsubscribe/complaint and clearing the way to email
  // an address that had explicitly opted out. Now only removable by the
  // key that owns it; both "doesn't exist" and "exists but belongs to
  // someone else" return the same 404 rather than confirming which.
  fastify.delete(
    '/suppressions/:email',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { email } = request.params as { email: string };
      const decoded = decodeURIComponent(email).trim().toLowerCase();
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.suppression.findFirst({ where: { email: decoded, apiKeyId } });
      if (!existing) throw Errors.notFound('Suppression entry not found.');

      await prisma.suppression.delete({ where: { id: existing.id } });
      return reply.status(200).send({ deleted: true, email: decoded });
    },
  );
}

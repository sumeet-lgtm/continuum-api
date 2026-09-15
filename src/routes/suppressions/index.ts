import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { withTenant, withRlsBypass } from '../../lib/tenantContext.js';
import { Errors } from '../../plugins/errorHandler.js';

const addSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()),
  reason: z.enum(['manual']).default('manual'),
});

const bulkSchema = z.object({
  emails: z.array(z.string()).min(1).max(5000),
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

      const apiKeyId = request.apiKey.id;
      const where = {
        ...(q.reason ? { reason: q.reason as never } : {}),
        OR: [{ apiKeyId }, { apiKeyId: null }],
      };

      // TODO(RLS): this deliberately shows the caller's own entries PLUS
      // unattributed (apiKeyId: null) ones, but never another named
      // tenant's — using withTenant here is the conservative choice (it
      // can never leak another tenant's rows), but if the Suppression RLS
      // policy scopes SELECT to `apiKeyId = current tenant` only (and not
      // `OR apiKeyId IS NULL`), the unattributed rows this endpoint used to
      // return will silently disappear from the result. Verify the actual
      // policy text once the migration lands, and widen Suppression's
      // policy (or add a narrower bypass+filter) if so.
      const [items, total] = await withTenant(apiKeyId, (tx) => Promise.all([
        tx.suppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, email: true, reason: true, createdAt: true },
        }),
        tx.suppression.count({ where }),
      ]));

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/suppressions/stats — reason breakdown counts
  fastify.get(
    '/suppressions/stats',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const where = { OR: [{ apiKeyId }, { apiKeyId: null }] };

      // TODO(RLS): see the note on GET /suppressions above — same
      // own-plus-unattributed scope, same caveat about the real policy.
      const [groups, total] = await withTenant(apiKeyId, (tx) => Promise.all([
        tx.suppression.groupBy({
          by: ['reason'],
          where,
          _count: { reason: true },
        }),
        tx.suppression.count({ where }),
      ]));
      const byReason: Record<string, number> = {};
      for (const g of groups) {
        byReason[g.reason] = g._count.reason;
      }

      return reply.status(200).send({ total, byReason });
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

      // Wrapped per-batch (not once for the whole loop) so a long CSV export
      // doesn't hold a single transaction open for its entire duration —
      // same query-per-iteration shape the original code had.
      while (true) {
        const batch = await withTenant(apiKeyId, (tx) => tx.suppression.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: batchSize,
          select: { email: true, reason: true, createdAt: true },
        }));
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

  // POST /v1/suppressions/bulk — import up to 5000 emails at once
  fastify.post(
    '/suppressions/bulk',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bulkSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { emails } = parsed.data;
      const apiKeyId = request.apiKey.id;
      const normalized = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
      const invalid = emails.length - normalized.length;

      // tenant-sweep: Suppression is deliberately global (see schema.prisma) — not scoped by apiKeyId.
      // withRlsBypass: must see whether ANY tenant already suppressed these
      // addresses, not just this caller's own rows.
      const existing = await withRlsBypass((tx) => tx.suppression.findMany({
        where: { email: { in: normalized } },
        select: { email: true },
      }));
      const existingSet = new Set(existing.map(e => e.email));
      const newEmails = normalized.filter(e => !existingSet.has(e));

      if (newEmails.length > 0) {
        // New rows are explicitly attributed to this tenant — a normal
        // tenant-scoped write, unlike the global read above.
        await withTenant(apiKeyId, (tx) => tx.suppression.createMany({
          data: newEmails.map(email => ({ email, reason: 'manual', apiKeyId })),
          skipDuplicates: true,
        }));
      }

      return reply.status(200).send({
        added: newEmails.length,
        skipped: existingSet.size,
        invalid,
        total: normalized.length,
      });
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

      // withRlsBypass: "already suppressed by anyone" is a deliberately
      // global check (see comment above) — must not miss another tenant's
      // existing entry for this address.
      const existing = await withRlsBypass((tx) => tx.suppression.findUnique({ where: { email } }));
      if (existing) {
        return reply.status(200).send({
          id: existing.id, email: existing.email, reason: existing.reason, createdAt: existing.createdAt,
        });
      }

      const record = await withTenant(apiKeyId, (tx) => tx.suppression.create({
        data: { email, reason: 'manual', apiKeyId },
        select: { id: true, email: true, reason: true, createdAt: true },
      }));

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

      await withTenant(apiKeyId, async (tx) => {
        const existing = await tx.suppression.findFirst({ where: { email: decoded, apiKeyId } });
        if (!existing) throw Errors.notFound('Suppression entry not found.');

        await tx.suppression.delete({ where: { id: existing.id } });
      });
      return reply.status(200).send({ deleted: true, email: decoded });
    },
  );
}

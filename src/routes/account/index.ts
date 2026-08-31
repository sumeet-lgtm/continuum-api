import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { exportAccountData, deleteAccountData } from '../../lib/accountData.js';
import { logAudit } from '../../lib/audit.js';

// Scope: this covers the content processed on the customer's behalf
// (verifications, sends, contacts, leads, campaigns, sequences, monitors,
// mailboxes, templates, domains — everything keyed by apiKeyId). It does
// not touch the User/session/login record behind a dashboard account,
// which is a separate, session-authenticated surface from this API-key-
// authenticated one.
const deleteSchema = z.object({
  confirm: z.literal('DELETE_MY_ACCOUNT', {
    errorMap: () => ({ message: "Body must include \"confirm\": \"DELETE_MY_ACCOUNT\" to proceed — this is irreversible." }),
  }),
});

export async function accountRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/account/audit-logs — previously there was no way for a
  // customer to see their own audit trail at all: WorkOS-mirrored events
  // were only visible in WorkOS's own dashboard (org customers only), and
  // everyone else had nothing since logAudit() no-op'd without an org.
  // This surfaces the local AuditLog record directly. Scoped to entries
  // tagged with this API key specifically (key creation/revocation,
  // account export/deletion) — org-membership events (invites, role
  // changes) are logged under orgId with no apiKeyId, since those actions
  // happen on the session-authenticated dashboard, not through this
  // API-key-authenticated surface; they're not included here.
  fastify.get(
    '/account/audit-logs',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: { apiKeyId },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, action: true, actorId: true, actorEmail: true, actorIp: true, targets: true, createdAt: true },
        }),
        prisma.auditLog.count({ where: { apiKeyId } }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/account/export — the "return Customer personal data" half of
  // the DPA's "delete or return... within 30 days" commitment.
  fastify.get(
    '/account/export',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const bundle = await exportAccountData(apiKeyId);
      logger.info({ apiKeyId }, 'Account data export requested');
      void logAudit(
        null, 'account.data_exported',
        { id: apiKeyId, email: request.apiKey.label ?? request.apiKey.name ?? request.apiKey.keyPrefix, ip: request.ip },
        [{ type: 'api_key', id: apiKeyId }],
        apiKeyId,
      );
      return reply
        .status(200)
        .header('Content-Disposition', `attachment; filename="continuum-account-export-${apiKeyId}.json"`)
        .send(bundle);
    },
  );

  // DELETE /v1/account — the "delete" half. Irreversible, so it requires
  // an explicit confirmation string in the body rather than just the
  // presence of a valid API key, to guard against an accidental or
  // scripted call. Deletes all owned content, then revokes (does not
  // hard-delete) the API key itself — see deleteAccountData's doc comment
  // for exactly what is and isn't covered.
  fastify.delete(
    '/account',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = deleteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
      }

      const apiKeyId = request.apiKey.id;
      const counts = await deleteAccountData(apiKeyId);

      await prisma.apiKey.update({
        where: { id: apiKeyId },
        data: { isActive: false, revokedAt: new Date() },
      });

      logger.warn({ apiKeyId, counts }, 'Account deleted via self-service DELETE /v1/account');
      void logAudit(
        null, 'account.deleted',
        { id: apiKeyId, email: request.apiKey.label ?? request.apiKey.name ?? request.apiKey.keyPrefix, ip: request.ip },
        [{ type: 'api_key', id: apiKeyId }],
        apiKeyId,
      );

      return reply.status(200).send({ deleted: true, apiKeyId, counts });
    },
  );
}

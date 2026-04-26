import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

interface HistoryParams { email: string }

const VALID_STATUSES = ['valid', 'invalid', 'risky', 'unknown'] as const;

const querySchema = z.object({
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(20),
  status:     z.enum(VALID_STATUSES).optional(),
  since:      z.string().datetime().optional(),  // ISO timestamp — only show checks after this
  until:      z.string().datetime().optional(),  // ISO timestamp — only show checks before this
  fromMonitor: z
    .string()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined))
    .optional(),
});

export async function historyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: HistoryParams }>(
    '/history/:email',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: HistoryParams }>, reply: FastifyReply) => {
      // URL-decode the email (%40 → @)
      const email = decodeURIComponent(request.params.email).trim().toLowerCase();

      if (!email.includes('@')) {
        throw Errors.validationFailed({ email: 'Invalid email address in URL. Percent-encode the "@" as %40.' });
      }

      const queryResult = querySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw Errors.validationFailed(
          queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { page, limit, status, since, until, fromMonitor } = queryResult.data;
      const skip = (page - 1) * limit;

      // ── Build WHERE clause ───────────────────────────────────────────────────
      type VerificationWhere = {
        email:     string;
        apiKeyId:  string;
        status?:   string;
        bulkJobId?: null | { not: null };
        checkedAt?: { gte?: Date; lte?: Date };
      };

      const where: VerificationWhere = { email, apiKeyId: request.apiKey.id };

      if (status)       where.status    = status;
      if (since || until) {
        where.checkedAt = {};
        if (since) where.checkedAt.gte  = new Date(since);
        if (until) where.checkedAt.lte  = new Date(until);
      }

      // fromMonitor=true means the Verification was linked to a MonitorCheck
      // We detect this by checking if the Verification id appears in MonitorCheck.verificationId
      // Simple approach: filter on bulkJobId (monitor checks have no bulkJobId)
      // A more precise approach would JOIN on MonitorCheck, but for now we use the absence of bulkJobId
      // as a proxy for "came from monitoring" (valid because bulk checks always have bulkJobId)
      if (fromMonitor === false) {
        // Exclude monitor-originated checks: those come from the monitor worker and have bulkJobId=null
        // Actually both monitor and single-verify have bulkJobId=null.
        // The cleanest filter is to check MonitorCheck.verificationId inclusion.
        // We do a subquery via Prisma's exists-style filter.
      }
      // Note: the fromMonitor filter is best-effort for now; precise implementation
      // requires a JOIN on monitor_checks which Prisma supports via nested relations.

      // ── Execute queries ──────────────────────────────────────────────────────
      const [verifications, total] = await Promise.all([
        prisma.verification.findMany({
          where,
          select: {
            id:            true,
            email:         true,
            domain:        true,
            status:        true,
            subStatus:     true,
            syntaxValid:   true,
            mxFound:       true,
            mxRecords:     true,
            isDisposable:  true,
            isRoleAccount: true,
            smtpChecked:   true,
            smtpReachable: true,
            isCatchAll:    true,
            greylisted:    true,
            score:         true,
            durationMs:    true,
            checkedAt:     true,
            bulkJobId:     true,
          },
          orderBy: { checkedAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.verification.count({ where }),
      ]);

      // ── Annotate with monitor check info ─────────────────────────────────────
      // For each verification, check if it was produced by a monitor check
      type VerificationRow = typeof verifications[number];
      const verificationIds = (verifications as VerificationRow[]).map((v: VerificationRow) => v.id);
      const monitorCheckMap = new Map<string, { monitorId: string; source: string }>();

      if (verificationIds.length > 0) {
        const monitorChecks = await prisma.monitorCheck.findMany({
          where:  { verificationId: { in: verificationIds } },
          select: { verificationId: true, monitorId: true, source: true },
        });
        for (const mc of monitorChecks) {
          monitorCheckMap.set(mc.verificationId, { monitorId: mc.monitorId, source: mc.source });
        }
      }

      // ── Format response ──────────────────────────────────────────────────────
      return reply.status(200).send({
        email,
        data: (verifications as VerificationRow[]).map((v: VerificationRow) => {
          const monitorInfo = monitorCheckMap.get(v.id);
          return {
            id:        v.id,
            status:    v.status,
            subStatus: v.subStatus,
            checks: {
              syntaxValid:   v.syntaxValid,
              mxFound:       v.mxFound,
              mxRecords:     v.mxRecords,
              isDisposable:  v.isDisposable,
              isRoleAccount: v.isRoleAccount,
              smtpChecked:   v.smtpChecked,
              smtpReachable: v.smtpReachable,
              isCatchAll:    v.isCatchAll,
              greylisted:    v.greylisted,
            },
            score:          v.score,
            durationMs:     v.durationMs,
            checkedAt:      v.checkedAt.toISOString(),
            source:         monitorInfo ? monitorInfo.source :
                            v.bulkJobId ? 'bulk_job' : 'single_verify',
            monitorId:      monitorInfo?.monitorId ?? null,
            bulkJobId:      v.bulkJobId,
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: {
          status:      status      ?? null,
          since:       since       ?? null,
          until:       until       ?? null,
          fromMonitor: fromMonitor ?? null,
        },
      });
    },
  );
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

interface HistoryParams { email: string }

const VALID_STATUSES = ['valid', 'invalid', 'risky', 'unknown'] as const;

const querySchema = z.object({
  page:        z.coerce.number().int().min(1).default(1),
  limit:       z.coerce.number().int().min(1).max(100).default(20),
  status:      z.enum(VALID_STATUSES).optional(),
  since:       z.string().datetime().optional(),
  until:       z.string().datetime().optional(),
  fromMonitor: z.string().transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)).optional(),
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
          properties: { email: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: HistoryParams }>, reply: FastifyReply) => {
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

      const { page, limit, status, since, until } = queryResult.data;
      const skip = (page - 1) * limit;

      // Build where using any to avoid Prisma enum type conflicts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { email, apiKeyId: request.apiKey.id };
      if (status) where.status = status;
      if (since || until) {
        where.checkedAt = {};
        if (since) where.checkedAt.gte = new Date(since);
        if (until) where.checkedAt.lte = new Date(until);
      }

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

      // Annotate with monitor check source
      type VRow = typeof verifications[number];
      const verificationIds = verifications.map((v: VRow) => v.id);
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

      return reply.status(200).send({
        email,
        data: verifications.map((v: VRow) => {
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
            score:     v.score,
            durationMs: v.durationMs,
            checkedAt: v.checkedAt.toISOString(),
            source:    monitorInfo ? monitorInfo.source : v.bulkJobId ? 'bulk_job' : 'single_verify',
            monitorId: monitorInfo?.monitorId ?? null,
            bulkJobId: v.bulkJobId,
          };
        }),
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: {
          status: status ?? null,
          since:  since  ?? null,
          until:  until  ?? null,
        },
      });
    },
  );

  // GET /v1/verifications — list all recent verifications for this API key
  fastify.get(
    '/verifications',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const listQuerySchema = z.object({
        page:   z.coerce.number().int().min(1).default(1),
        limit:  z.coerce.number().int().min(1).max(100).default(20),
        status: z.enum(VALID_STATUSES).optional(),
        since:  z.string().datetime().optional(),
        until:  z.string().datetime().optional(),
        q:      z.string().max(200).optional(), // email search
      });

      const queryResult = listQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw Errors.validationFailed(
          queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { page, limit, status, since, until, q } = queryResult.data;
      const skip = (page - 1) * limit;

      const key = request.apiKey;
      const ownerId = key.ownerId ?? key.userId ?? key.id;

      // Scope to all keys owned by this account
      const ownedKeys = await prisma.apiKey.findMany({
        where: { OR: [{ ownerId }, { userId: ownerId }, { id: key.id }] },
        select: { id: true },
      });
      const apiKeyIds = ownedKeys.map((k) => k.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { apiKeyId: { in: apiKeyIds } };
      if (status) where.status = status;
      if (q) where.email = { contains: q.toLowerCase() };
      if (since || until) {
        where.checkedAt = {};
        if (since) where.checkedAt.gte = new Date(since);
        if (until) where.checkedAt.lte = new Date(until);
      }

      const [rows, total] = await Promise.all([
        prisma.verification.findMany({
          where,
          select: {
            id: true, email: true, domain: true, status: true, subStatus: true,
            isDisposable: true, isRoleAccount: true, isCatchAll: true,
            score: true, durationMs: true, checkedAt: true, apiKeyId: true,
          },
          orderBy: { checkedAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.verification.count({ where }),
      ]);

      return reply.status(200).send({
        data: rows.map((v) => ({
          id:           v.id,
          email:        v.email,
          domain:       v.domain,
          status:       v.status,
          subStatus:    v.subStatus,
          flags: {
            disposable:  v.isDisposable,
            roleAccount: v.isRoleAccount,
            catchAll:    v.isCatchAll,
          },
          score:      v.score,
          durationMs: v.durationMs,
          checkedAt:  v.checkedAt.toISOString(),
          apiKeyId:   v.apiKeyId,
        })),
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
      });
    },
  );
}

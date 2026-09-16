import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { getMonitorLimit } from '../../plugins/usageMeter.js';
import { withTenant, withRlsBypass } from '../../lib/tenantContext.js';
import { monitorQueue } from '../../lib/queue.js';
import type { MonitorRecheckPayload } from '../../types/job.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Valid recheck cadences in hours
const VALID_INTERVALS = [1, 6, 12, 24, 48, 72, 168] as const;

// ─── Input schemas ────────────────────────────────────────────────────────────

const createSchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .email('Must be a valid email address')
    .max(254)
    .transform((s) => s.trim().toLowerCase()),
  intervalHours: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVALS as readonly number[]).includes(v), {
      message: `intervalHours must be one of: ${VALID_INTERVALS.join(', ')}`,
    })
    .default(24),
  tags: z
    .array(z.string().max(64))
    .max(10, 'Maximum 10 tags per monitor')
    .optional()
    .default([]),
  notifyOnAnyChange: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  intervalHours: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVALS as readonly number[]).includes(v), {
      message: `intervalHours must be one of: ${VALID_INTERVALS.join(', ')}`,
    })
    .optional(),
  isActive: z.boolean().optional(),
  tags: z.array(z.string().max(64)).max(10).optional(),
  notifyOnAnyChange: z.boolean().optional(),
});

const listQuerySchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  isActive: z
    .string()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined))
    .optional(),
  isPaused: z
    .string()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined))
    .optional(),
  tag: z.string().optional(),
  email: z.string().optional(),
});

interface MonitorParams { id: string }

// ─── Shared select fields ─────────────────────────────────────────────────────

const MONITOR_SELECT = {
  id:                  true,
  email:               true,
  intervalHours:       true,
  isActive:            true,
  lastCheckedAt:       true,
  nextCheckAt:         true,
  lastStatus:          true,
  consecutiveFailures: true,
  pausedAt:            true,
  failureReason:       true,
  tags:                true,
  notifyOnAnyChange:   true,
  createdAt:           true,
  updatedAt:           true,
} as const;

type MonitorSelectResult = {
  id:                  string;
  email:               string;
  intervalHours:       number;
  isActive:            boolean;
  lastCheckedAt:       Date | null;
  nextCheckAt:         Date;
  lastStatus:          string | null;
  consecutiveFailures: number;
  pausedAt:            Date | null;
  failureReason:       string | null;
  tags:                string[];
  notifyOnAnyChange:   boolean;
  createdAt:           Date;
  updatedAt:           Date;
};

function formatMonitor(m: MonitorSelectResult) {
  return {
    id:                  m.id,
    email:               m.email,
    intervalHours:       m.intervalHours,
    isActive:            m.isActive,
    isPaused:            m.pausedAt !== null,
    lastCheckedAt:       m.lastCheckedAt?.toISOString()  ?? null,
    nextCheckAt:         m.nextCheckAt.toISOString(),
    lastStatus:          m.lastStatus,
    consecutiveFailures: m.consecutiveFailures,
    pausedAt:            m.pausedAt?.toISOString()        ?? null,
    failureReason:       m.failureReason,
    tags:                m.tags,
    notifyOnAnyChange:   m.notifyOnAnyChange,
    createdAt:           m.createdAt.toISOString(),
    updatedAt:           m.updatedAt.toISOString(),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function monitoringRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /v1/monitoring ─────────────────────────────────────────────────────
  fastify.post(
    '/monitoring',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { email, intervalHours, tags, notifyOnAnyChange } = parsed.data;

      const monitor = await withTenant(request.apiKey.id, async (tx) => {
        // Enforce per-plan monitor cap
        const monitorLimit  = getMonitorLimit(request.apiKey.plan);
        const existingCount = await tx.monitor.count({
          where: { apiKeyId: request.apiKey.id },
        });
        if (existingCount >= monitorLimit) {
          throw Errors.validationFailed({
            limit: `Your ${request.apiKey.plan ?? 'free'} plan allows ${monitorLimit} monitors. Delete some or upgrade to add more.`,
          });
        }

        // Check for an existing monitor for this email under this key
        const existing = await tx.monitor.findUnique({
          where: { apiKeyId_email: { apiKeyId: request.apiKey.id, email } },
          select: { id: true, isActive: true, pausedAt: true },
        });

        if (existing) {
          if (existing.isActive && !existing.pausedAt) {
            throw Errors.validationFailed({
              email: `A monitor for "${email}" already exists (id: ${existing.id}). PATCH it to change settings.`,
            });
          }
          // Re-activate a paused or inactive monitor
          const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);
          const reactivated = await tx.monitor.update({
            where: { id: existing.id },
            data: {
              isActive:            true,
              intervalHours,
              tags,
              notifyOnAnyChange,
              nextCheckAt,
              pausedAt:            null,
              failureReason:       null,
              consecutiveFailures: 0,
            },
            select: MONITOR_SELECT,
          });
          return { status: 200 as const, body: formatMonitor(reactivated) };
        }

        const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);
        const created = await tx.monitor.create({
          data: {
            apiKeyId:         request.apiKey.id,
            email,
            intervalHours,
            tags,
            notifyOnAnyChange,
            nextCheckAt,
            isActive:         true,
          },
          select: MONITOR_SELECT,
        });

        logger.info({ monitorId: created.id, email, intervalHours }, 'Monitor created');
        return { status: 201 as const, body: formatMonitor(created) };
      });

      return reply.status(monitor.status).send(monitor.body);
    },
  );

  // ── GET /v1/monitoring ──────────────────────────────────────────────────────
  fastify.get(
    '/monitoring',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const queryResult = listQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw Errors.validationFailed(
          queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { page, limit, isActive, isPaused, tag, email } = queryResult.data;
      const skip = (page - 1) * limit;

      type WhereClause = {
        apiKeyId:  string;
        isActive?: boolean;
        pausedAt?: { not: null } | null;
        tags?:     { has: string };
        email?:    { contains: string; mode: 'insensitive' };
      };

      const where: any = { apiKeyId: request.apiKey.id };
      if (isActive !== undefined) where.isActive = isActive;
      if (isPaused === true)      where.pausedAt = { not: null };
      if (isPaused === false)     where.pausedAt = null;
      if (tag)                    where.tags     = { has: tag };
      if (email)                  where.email    = { contains: email, mode: 'insensitive' };

      const [monitors, total] = await withTenant(request.apiKey.id, (tx) => Promise.all([
        tx.monitor.findMany({
          where,
          select: MONITOR_SELECT,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        tx.monitor.count({ where }),
      ]));

      return reply.status(200).send({
        data: monitors.map(formatMonitor),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: {
          isActive:  isActive  ?? null,
          isPaused:  isPaused  ?? null,
          tag:       tag       ?? null,
          email:     email     ?? null,
        },
      });
    },
  );

  // ── GET /v1/monitoring/:id ──────────────────────────────────────────────────
  fastify.get<{ Params: MonitorParams }>(
    '/monitoring/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: MonitorParams }>, reply: FastifyReply) => {
      // Ownership isn't known until after this lookup-by-id, so it can't be
      // tenant-scoped up front; withRlsBypass is correct here because the
      // very next line is the actual, explicit ownership check this route
      // has always relied on.
      const monitor = await withRlsBypass((tx) => tx.monitor.findUnique({
        where: { id: request.params.id },
        select: {
          ...MONITOR_SELECT,
          apiKeyId: true,
          checks: {
            select: {
              id:             true,
              statusChanged:  true,
              previousStatus: true,
              newStatus:      true,
              source:         true,
              checkedAt:      true,
              durationMs:     true,
              webhookSent:    true,
              verificationId: true,
            },
            orderBy: { checkedAt: 'desc' },
            take: 20,
          },
        },
      }));

      if (!monitor || monitor.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Monitor');
      }

      return reply.status(200).send({
        ...formatMonitor(monitor),
        recentChecks: monitor.checks.map((c: typeof monitor.checks[number]) => ({
          id:             c.id,
          statusChanged:  c.statusChanged,
          previousStatus: c.previousStatus,
          newStatus:      c.newStatus,
          source:         c.source,
          checkedAt:      c.checkedAt.toISOString(),
          durationMs:     c.durationMs,
          webhookSent:    c.webhookSent,
          verificationId: c.verificationId,
        })),
      });
    },
  );

  // ── PATCH /v1/monitoring/:id ────────────────────────────────────────────────
  fastify.patch<{ Params: MonitorParams }>(
    '/monitoring/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: MonitorParams }>, reply: FastifyReply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const updates = parsed.data;
      if (Object.keys(updates).length === 0) {
        throw Errors.validationFailed({ body: 'At least one field is required.' });
      }

      const monitor = await withRlsBypass((tx) => tx.monitor.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true, intervalHours: true },
      }));
      if (!monitor || monitor.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Monitor');
      }

      const newInterval = updates.intervalHours ?? monitor.intervalHours;

      type UpdateData = {
        intervalHours?:        number;
        isActive?:             boolean;
        tags?:                 string[];
        notifyOnAnyChange?:    boolean;
        nextCheckAt?:          Date;
        pausedAt?:             null;
        consecutiveFailures?:  number;
        failureReason?:        null;
      };

      const data: UpdateData = {};
      if (updates.intervalHours  !== undefined) data.intervalHours       = updates.intervalHours;
      if (updates.tags           !== undefined) data.tags                = updates.tags;
      if (updates.notifyOnAnyChange !== undefined) data.notifyOnAnyChange = updates.notifyOnAnyChange;

      // Re-activating clears pause state and resets failure counter
      if (updates.isActive !== undefined) {
        data.isActive = updates.isActive;
        if (updates.isActive) {
          data.pausedAt             = null;
          data.consecutiveFailures  = 0;
          data.failureReason        = null;
          data.nextCheckAt          = new Date(Date.now() + newInterval * 3600 * 1000);
        }
      }

      // If interval changed (and not already handled by re-activation), update nextCheckAt
      if (updates.intervalHours !== undefined && updates.isActive === undefined) {
        data.nextCheckAt = new Date(Date.now() + newInterval * 3600 * 1000);
      }

      // Ownership already verified above for this exact id — writing under
      // bypass here is the same "app already did the real check" pattern,
      // not a shortcut around it.
      const updated = await withRlsBypass((tx) => tx.monitor.update({
        where: { id: request.params.id },
        data,
        select: MONITOR_SELECT,
      }));

      return reply.status(200).send(formatMonitor(updated));
    },
  );

  // ── DELETE /v1/monitoring/:id ───────────────────────────────────────────────
  fastify.delete<{ Params: MonitorParams }>(
    '/monitoring/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: MonitorParams }>, reply: FastifyReply) => {
      const monitor = await withRlsBypass((tx) => tx.monitor.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true },
      }));
      if (!monitor || monitor.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Monitor');
      }

      await withRlsBypass((tx) => tx.monitor.delete({ where: { id: request.params.id } }));
      return reply.status(200).send({ id: request.params.id, deleted: true });
    },
  );

  // ── POST /v1/monitoring/:id/recheck ─────────────────────────────────────────
  // Trigger an immediate recheck outside the scheduled cadence.
  fastify.post<{ Params: MonitorParams }>(
    '/monitoring/:id/recheck',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: MonitorParams }>, reply: FastifyReply) => {
      const monitor = await withRlsBypass((tx) => tx.monitor.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true, email: true, isActive: true },
      }));

      if (!monitor || monitor.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Monitor');
      }

      if (!monitor.isActive) {
        throw Errors.validationFailed({
          isActive: 'Monitor is inactive. Reactivate it (PATCH isActive: true) before triggering a recheck.',
        });
      }

      // Set nextCheckAt to now so the next monitor tick picks it up immediately,
      // and enqueue a dedicated single-monitor job that fires right now.
      await withRlsBypass((tx) => tx.monitor.update({
        where: { id: monitor.id },
        data:  { nextCheckAt: new Date() },
      }));

      await monitorQueue.add(
        'recheck-single',
        { monitorId: monitor.id, source: 'manual_recheck' } as MonitorRecheckPayload,
        {
          jobId:    `recheck-${monitor.id}-${Date.now()}`,
          priority: 1, // higher priority than scheduled ticks
        },
      );

      logger.info({ monitorId: monitor.id, email: monitor.email }, 'Manual recheck enqueued');

      return reply.status(202).send({
        monitorId: monitor.id,
        email:     monitor.email,
        message:   'Recheck enqueued. The next monitor tick will process it immediately.',
        enqueuedAt: new Date().toISOString(),
      });
    },
  );

  // ── GET /v1/monitoring/:id/checks ───────────────────────────────────────────
  // Paginated check history for a specific monitor.
  fastify.get<{ Params: MonitorParams }>(
    '/monitoring/:id/checks',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: MonitorParams }>, reply: FastifyReply) => {
      const queryResult = z.object({
        page:          z.coerce.number().int().min(1).default(1),
        limit:         z.coerce.number().int().min(1).max(100).default(20),
        statusChanged: z.string().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined).optional(),
      }).safeParse(request.query);

      if (!queryResult.success) {
        throw Errors.validationFailed(
          queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { page, limit, statusChanged } = queryResult.data;

      const monitor = await withRlsBypass((tx) => tx.monitor.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true, email: true },
      }));

      if (!monitor || monitor.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Monitor');
      }
      const where: any = { monitorId: monitor.id };
      if (statusChanged !== undefined) where.statusChanged = statusChanged;

      const skip = (page - 1) * limit;

      const [checks, total] = await withTenant(request.apiKey.id, (tx) => Promise.all([
        tx.monitorCheck.findMany({
          where,
          select: {
            id:             true,
            statusChanged:  true,
            previousStatus: true,
            newStatus:      true,
            source:         true,
            checkedAt:      true,
            durationMs:     true,
            webhookSent:    true,
            verificationId: true,
          },
          orderBy: { checkedAt: 'desc' },
          skip,
          take: limit,
        }),
        tx.monitorCheck.count({ where }),
      ]));

      return reply.status(200).send({
        monitorId: monitor.id,
        email:     monitor.email,
        data:      (checks as Array<typeof checks[number]>).map((c: typeof checks[number]) => ({
          id:             c.id,
          statusChanged:  c.statusChanged,
          previousStatus: c.previousStatus,
          newStatus:      c.newStatus,
          source:         c.source,
          checkedAt:      c.checkedAt.toISOString(),
          durationMs:     c.durationMs,
          webhookSent:    c.webhookSent,
          verificationId: c.verificationId,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: { statusChanged: statusChanged ?? null },
      });
    },
  );
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { getAgentRunLimit } from '../../plugins/usageMeter.js';
import { prisma } from '../../lib/prisma.js';
import { withTenant } from '../../lib/tenantContext.js';
import { agentRunQueue } from '../../lib/queue.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import type { AgentRunKickPayload } from '../../types/job.js';

// Only 'verification' is buildable today — the other AgentPillar enum
// values exist in the schema for the pillars on the roadmap, but creating
// a run for them isn't supported by any worker yet.
const SUPPORTED_PILLARS = ['verification'] as const;

const VALID_INTERVALS = [1, 6, 12, 24, 48, 72, 168] as const;

const createSchema = z.object({
  pillar: z.enum(SUPPORTED_PILLARS).default('verification'),
  name: z.string().max(200).optional(),
  listId: z.string({ required_error: 'listId is required' }).min(1),
  intervalHours: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVALS as readonly number[]).includes(v), {
      message: `intervalHours must be one of: ${VALID_INTERVALS.join(', ')}`,
    })
    .default(24),
  autoRemoveInvalid: z.boolean().optional().default(false),
  cutoffDays: z.number().int().min(1).max(365).optional().default(30),
});

const updateSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  intervalHours: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVALS as readonly number[]).includes(v), {
      message: `intervalHours must be one of: ${VALID_INTERVALS.join(', ')}`,
    })
    .optional(),
  autoRemoveInvalid: z.boolean().optional(),
  cutoffDays: z.number().int().min(1).max(365).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  pillar: z.enum(SUPPORTED_PILLARS).optional(),
  status: z.string().optional(),
});

interface AgentRunParams { id: string }

const AGENT_RUN_SELECT = {
  id: true,
  pillar: true,
  name: true,
  status: true,
  config: true,
  errorMessage: true,
  intervalHours: true,
  nextCheckAt: true,
  lastCheckedAt: true,
  consecutiveFailures: true,
  pausedAt: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  cancelledAt: true,
} as const;

type AgentRunSelectResult = {
  id: string;
  pillar: string;
  name: string | null;
  status: string;
  config: unknown;
  errorMessage: string | null;
  intervalHours: number | null;
  nextCheckAt: Date | null;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
  pausedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  cancelledAt: Date | null;
};

function formatAgentRun(r: AgentRunSelectResult) {
  return {
    id: r.id,
    pillar: r.pillar,
    name: r.name,
    status: r.status,
    config: r.config,
    errorMessage: r.errorMessage,
    intervalHours: r.intervalHours,
    nextCheckAt: r.nextCheckAt?.toISOString() ?? null,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    consecutiveFailures: r.consecutiveFailures,
    isPaused: r.pausedAt !== null,
    pausedAt: r.pausedAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  };
}

export async function agentRunRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /v1/agent-runs ────────────────────────────────────────────────────
  fastify.post('/agent-runs', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }

    const apiKeyId = request.apiKey.id;
    const { pillar, name, listId, intervalHours, autoRemoveInvalid, cutoffDays } = parsed.data;

    const runLimit = getAgentRunLimit(request.apiKey.plan);
    const existingCount = await prisma.agentRun.count({
      where: { apiKeyId, status: { notIn: ['cancelled', 'failed'] } },
    });
    if (existingCount >= runLimit) {
      throw Errors.validationFailed({
        limit: `Your ${request.apiKey.plan ?? 'free'} plan allows ${runLimit} active agent runs. Cancel one or upgrade to add more.`,
      });
    }

    // Root-cause pattern from the 2026-09-14 isolation incident: validate
    // the referenced list belongs to this key BEFORE using it, not just
    // scope the later read — an unscoped/unvalidated foreign id is exactly
    // the bug class that caused that incident.
    const list = await withTenant(apiKeyId, (tx) =>
      tx.mailingList.findFirst({ where: { id: listId, apiKeyId }, select: { id: true } }),
    );
    if (!list) throw Errors.notFound('Mailing list');

    const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);

    const run = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.create({
        data: {
          apiKeyId,
          pillar,
          name: name ?? null,
          status: 'active',
          config: { listId, autoRemoveInvalid, cutoffDays },
          intervalHours,
          nextCheckAt,
          createdByEmail: request.apiKey.ownerId ?? null,
        },
        select: AGENT_RUN_SELECT,
      }),
    );

    logger.info({ agentRunId: run.id, apiKeyId, pillar, listId }, 'Agent run created');
    return reply.status(201).send(formatAgentRun(run as AgentRunSelectResult));
  });

  // ── GET /v1/agent-runs ──────────────────────────────────────────────────────
  fastify.get('/agent-runs', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const queryResult = listQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw Errors.validationFailed(queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
    const { page, limit, pillar, status } = queryResult.data;
    const apiKeyId = request.apiKey.id;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { apiKeyId };
    if (pillar) where['pillar'] = pillar;
    if (status) where['status'] = status;

    const [runs, total] = await withTenant(apiKeyId, (tx) => Promise.all([
      tx.agentRun.findMany({ where, select: AGENT_RUN_SELECT, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      tx.agentRun.count({ where }),
    ]));

    return reply.status(200).send({
      data: (runs as AgentRunSelectResult[]).map(formatAgentRun),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrev: page > 1 },
    });
  });

  // ── GET /v1/agent-runs/:id ───────────────────────────────────────────────────
  fastify.get<{ Params: AgentRunParams }>('/agent-runs/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const run = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: AGENT_RUN_SELECT }),
    );
    if (!run) throw Errors.notFound('Agent run');
    return reply.status(200).send(formatAgentRun(run as AgentRunSelectResult));
  });

  // ── GET /v1/agent-runs/:id/events ────────────────────────────────────────────
  fastify.get<{ Params: AgentRunParams }>('/agent-runs/:id/events', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const queryResult = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).safeParse(request.query);
    if (!queryResult.success) {
      throw Errors.validationFailed(queryResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
    const { page, limit } = queryResult.data;
    const apiKeyId = request.apiKey.id;

    const run = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: { id: true } }),
    );
    if (!run) throw Errors.notFound('Agent run');

    const skip = (page - 1) * limit;
    const [events, total] = await Promise.all([
      prisma.agentRunEvent.findMany({
        where: { agentRunId: run.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, eventType: true, message: true, data: true, createdAt: true },
      }),
      prisma.agentRunEvent.count({ where: { agentRunId: run.id } }),
    ]);

    return reply.status(200).send({
      agentRunId: run.id,
      data: events.map((e: typeof events[number]) => ({
        id: e.id,
        eventType: e.eventType,
        message: e.message,
        data: e.data,
        createdAt: e.createdAt.toISOString(),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrev: page > 1 },
    });
  });

  // ── PATCH /v1/agent-runs/:id ─────────────────────────────────────────────────
  // Kill switch (status: 'paused') and resume (status: 'active') live here,
  // plus config tweaks (interval, autoRemoveInvalid, cutoffDays).
  fastify.patch<{ Params: AgentRunParams }>('/agent-runs/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }
    const updates = parsed.data;
    if (Object.keys(updates).length === 0) throw Errors.validationFailed({ body: 'At least one field is required.' });

    const apiKeyId = request.apiKey.id;
    const existing = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: { id: true, status: true, config: true, intervalHours: true } }),
    );
    if (!existing) throw Errors.notFound('Agent run');
    if (existing.status === 'cancelled') throw Errors.validationFailed({ status: 'Cannot update a cancelled agent run.' });

    const newInterval = updates.intervalHours ?? existing.intervalHours ?? 24;
    const currentConfig = (existing.config ?? {}) as Record<string, unknown>;
    const newConfig = {
      ...currentConfig,
      ...(updates.autoRemoveInvalid !== undefined && { autoRemoveInvalid: updates.autoRemoveInvalid }),
      ...(updates.cutoffDays !== undefined && { cutoffDays: updates.cutoffDays }),
    };

    const data: Record<string, unknown> = { config: newConfig };
    if (updates.intervalHours !== undefined) data['intervalHours'] = updates.intervalHours;

    if (updates.status === 'paused') {
      data['status'] = 'paused';
      data['pausedAt'] = new Date();
    } else if (updates.status === 'active') {
      data['status'] = 'active';
      data['pausedAt'] = null;
      data['consecutiveFailures'] = 0;
      data['errorMessage'] = null;
      data['nextCheckAt'] = new Date(Date.now() + newInterval * 3600 * 1000);
    } else if (updates.intervalHours !== undefined && existing.status === 'active') {
      data['nextCheckAt'] = new Date(Date.now() + newInterval * 3600 * 1000);
    }

    const updated = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.update({ where: { id: request.params.id }, data, select: AGENT_RUN_SELECT }),
    );

    return reply.status(200).send(formatAgentRun(updated as AgentRunSelectResult));
  });

  // ── POST /v1/agent-runs/:id/cancel ───────────────────────────────────────────
  fastify.post<{ Params: AgentRunParams }>('/agent-runs/:id/cancel', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const existing = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: { id: true, status: true } }),
    );
    if (!existing) throw Errors.notFound('Agent run');
    if (existing.status === 'cancelled') {
      return reply.status(200).send({ id: existing.id, status: 'cancelled' });
    }

    const updated = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.update({
        where: { id: request.params.id },
        data: { status: 'cancelled', cancelledAt: new Date(), pausedAt: new Date() },
        select: AGENT_RUN_SELECT,
      }),
    );

    logger.info({ agentRunId: existing.id, apiKeyId }, 'Agent run cancelled');
    return reply.status(200).send(formatAgentRun(updated as AgentRunSelectResult));
  });

  // ── POST /v1/agent-runs/:id/trigger ──────────────────────────────────────────
  // Trigger an immediate tick outside the scheduled cadence — same idea as
  // POST /v1/monitoring/:id/recheck.
  fastify.post<{ Params: AgentRunParams }>('/agent-runs/:id/trigger', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const run = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: { id: true, status: true, pausedAt: true } }),
    );
    if (!run) throw Errors.notFound('Agent run');
    if (run.status !== 'active' || run.pausedAt) {
      throw Errors.validationFailed({ status: 'Agent run must be active (PATCH status: "active") before triggering a manual run.' });
    }

    await agentRunQueue.add(
      'agent-run-kick',
      { agentRunId: run.id } as AgentRunKickPayload,
      { jobId: `agent-run-kick-${run.id}-${Date.now()}`, priority: 1 },
    );

    logger.info({ agentRunId: run.id, apiKeyId }, 'Manual agent run trigger enqueued');
    return reply.status(202).send({ agentRunId: run.id, message: 'Triggered. Processing shortly.', enqueuedAt: new Date().toISOString() });
  });
}

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
import { createAndSendCampaignFromDraft } from '../../lib/nurtureAgent.js';
import { createSequenceAndEnrollFromDraft } from '../../lib/outboundAgent.js';
import { parseNurtureAgentConfig, parseOutboundAgentConfig } from '../../types/agentRun.js';
import type { AgentRunKickPayload } from '../../types/job.js';
import type { FinderSearchFilters } from '../../lib/finderSearch.js';
import { Prisma } from '@prisma/client';

// All five pillars are buildable today.
const SUPPORTED_PILLARS = ['verification', 'nurture', 'lead_finding', 'warmup', 'outbound'] as const;

const VALID_INTERVALS = [1, 6, 12, 24, 48, 72, 168] as const;
const TONE_VALUES = ['professional', 'casual', 'direct', 'technical'] as const;

const verificationCreateSchema = z.object({
  pillar: z.literal('verification').default('verification'),
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

// One-shot: draft → (approve) → send. No intervalHours/nextCheckAt — the
// worker is kicked once at creation instead of on a recurring cron tick.
const nurtureCreateSchema = z.object({
  pillar: z.literal('nurture'),
  name: z.string().max(200).optional(),
  listId: z.string({ required_error: 'listId is required' }).min(1),
  about: z.string({ required_error: 'about is required' }).min(1).max(1000),
  fromName: z.string({ required_error: 'fromName is required' }).min(1).max(200),
  fromEmail: z.string({ required_error: 'fromEmail is required' }).email(),
  replyTo: z.string().email().optional(),
  sender: z.object({
    name: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
    product: z.string().max(200).optional(),
  }).optional(),
  tone: z.enum(TONE_VALUES).optional(),
  // Off by default — the agent drafts and waits for a human to approve
  // (POST /:id/approve) before anything actually sends.
  autoSend: z.boolean().optional().default(false),
});

// Recurring, like verification — a saved search re-run on a cadence.
// searchFilters is intentionally loose here (validated for real by
// buildFinderActorInput's enum-normalization at tick time, the same
// validation the manual POST /v1/finder/search route relies on) rather than
// duplicated as a second, drifting zod schema for every one of its ~25
// fields.
const leadFindingCreateSchema = z.object({
  pillar: z.literal('lead_finding'),
  name: z.string().max(200).optional(),
  searchFilters: z.record(z.unknown(), { required_error: 'searchFilters is required' }),
  sequenceId: z.string().optional(),
  intervalHours: z
    .number()
    .int()
    .refine((v) => (VALID_INTERVALS as readonly number[]).includes(v), {
      message: `intervalHours must be one of: ${VALID_INTERVALS.join(', ')}`,
    })
    .default(168), // weekly — a search is slower/costlier than a verification check
});

// Recurring, per-mailbox. No intervalHours choice exposed — a daily safety
// check is the natural cadence for a ramp that itself only advances once
// per day (see workers/warmupWorker.ts's own lastRampDate guard).
const warmupCreateSchema = z.object({
  pillar: z.literal('warmup'),
  name: z.string().max(200).optional(),
  mailboxId: z.string({ required_error: 'mailboxId is required' }).min(1),
});

// One-shot: draft -> approve -> enroll. No autoSend at all — this is the
// highest-risk pillar (real cold sends to people who didn't opt in), so
// unlike nurture a human approval is not optional here.
const outboundCreateSchema = z.object({
  pillar: z.literal('outbound'),
  name: z.string().max(200).optional(),
  leadIds: z.array(z.string()).min(1, 'At least one leadId is required'),
  about: z.string({ required_error: 'about is required' }).min(1).max(1000),
  icpContext: z.string().max(1000).optional(),
  fromName: z.string({ required_error: 'fromName is required' }).min(1).max(200),
  fromEmail: z.string({ required_error: 'fromEmail is required' }).email(),
  mailboxId: z.string().optional(),
  stepCount: z.number().int().min(1).max(6).optional(),
  sender: z.object({
    name: z.string().max(200).optional(),
    company: z.string().max(200).optional(),
    product: z.string().max(200).optional(),
  }).optional(),
  tone: z.enum(TONE_VALUES).optional(),
});

// z.discriminatedUnion needs the literal `pillar` key present in the raw
// input to route to a branch — a request that omits it entirely (the
// pre-nurture API shape, still supported) would match neither branch before
// verificationCreateSchema's own .default() ever runs. Default it here.
const createSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('pillar' in val) ? { ...val, pillar: 'verification' } : val),
  z.discriminatedUnion('pillar', [verificationCreateSchema, nurtureCreateSchema, leadFindingCreateSchema, warmupCreateSchema, outboundCreateSchema]),
);

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
    const { pillar, name } = parsed.data;

    const runLimit = getAgentRunLimit(request.apiKey.plan);
    const existingCount = await prisma.agentRun.count({
      where: { apiKeyId, status: { notIn: ['cancelled', 'failed'] } },
    });
    if (existingCount >= runLimit) {
      throw Errors.validationFailed({
        limit: `Your ${request.apiKey.plan ?? 'free'} plan allows ${runLimit} active agent runs. Cancel one or upgrade to add more.`,
      });
    }

    let run: AgentRunSelectResult;

    if (parsed.data.pillar === 'verification') {
      const { listId, intervalHours, autoRemoveInvalid, cutoffDays } = parsed.data;

      // Root-cause pattern from the 2026-09-14 isolation incident: validate
      // the referenced list belongs to this key BEFORE using it, not just
      // scope the later read — an unscoped/unvalidated foreign id is
      // exactly the bug class that caused that incident.
      const list = await withTenant(apiKeyId, (tx) => tx.mailingList.findFirst({ where: { id: listId, apiKeyId }, select: { id: true } }));
      if (!list) throw Errors.notFound('Mailing list');

      const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);
      run = await withTenant(apiKeyId, (tx) =>
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
      ) as AgentRunSelectResult;
    } else if (parsed.data.pillar === 'nurture') {
      // One-shot, no interval/nextCheckAt — kicked once, immediately.
      const { listId, about, fromName, fromEmail, replyTo, sender, tone, autoSend } = parsed.data;

      const list = await withTenant(apiKeyId, (tx) => tx.mailingList.findFirst({ where: { id: listId, apiKeyId }, select: { id: true } }));
      if (!list) throw Errors.notFound('Mailing list');

      run = await withTenant(apiKeyId, (tx) =>
        tx.agentRun.create({
          data: {
            apiKeyId,
            pillar,
            name: name ?? null,
            status: 'active',
            config: {
              listId, about, fromName, fromEmail, autoSend,
              ...(replyTo !== undefined && { replyTo }),
              ...(sender !== undefined && { sender }),
              ...(tone !== undefined && { tone }),
            },
            createdByEmail: request.apiKey.ownerId ?? null,
          },
          select: AGENT_RUN_SELECT,
        }),
      ) as AgentRunSelectResult;

      await agentRunQueue.add(
        'agent-run-kick',
        { agentRunId: run.id } as AgentRunKickPayload,
        { jobId: `agent-run-kick-${run.id}-${Date.now()}` },
      );
    } else if (parsed.data.pillar === 'lead_finding') {
      // Lead Finding: recurring, like verification — no list to validate
      // (it searches externally, not a Continuum mailing list), but if a
      // sequenceId for auto-enroll was given, that DOES need the same
      // ownership check.
      const { searchFilters, sequenceId, intervalHours } = parsed.data;

      if (sequenceId) {
        const sequence = await withTenant(apiKeyId, (tx) => tx.sequence.findFirst({ where: { id: sequenceId, apiKeyId }, select: { id: true } }));
        if (!sequence) throw Errors.notFound('Sequence');
      }

      const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);
      run = await withTenant(apiKeyId, (tx) =>
        tx.agentRun.create({
          data: {
            apiKeyId,
            pillar,
            name: name ?? null,
            status: 'active',
            config: {
              searchFilters: searchFilters as FinderSearchFilters,
              ...(sequenceId !== undefined && { sequenceId }),
            } as unknown as Prisma.InputJsonValue,
            intervalHours,
            nextCheckAt,
            createdByEmail: request.apiKey.ownerId ?? null,
          },
          select: AGENT_RUN_SELECT,
        }),
      ) as AgentRunSelectResult;
    } else if (parsed.data.pillar === 'warmup') {
      // Warmup: recurring, daily, one agent per mailbox.
      const { mailboxId } = parsed.data;

      const mailbox = await withTenant(apiKeyId, (tx) => tx.mailbox.findFirst({
        where: { id: mailboxId, apiKeyId },
        select: { id: true, warmupConfig: { select: { dailyRampUp: true } } },
      }));
      if (!mailbox) throw Errors.notFound('Mailbox');
      if (!mailbox.warmupConfig) {
        throw Errors.validationFailed({ mailboxId: 'This mailbox does not have warmup enabled yet — enable it under Mailboxes first.' });
      }

      const existing = await prisma.agentRun.findFirst({
        where: {
          apiKeyId, pillar: 'warmup', status: { notIn: ['cancelled', 'failed'] },
          config: { path: ['mailboxId'], equals: mailboxId },
        },
        select: { id: true },
      });
      if (existing) {
        throw Errors.validationFailed({ mailboxId: `This mailbox already has an active warmup agent (id: ${existing.id}).` });
      }

      const intervalHours = 24;
      const nextCheckAt = new Date(Date.now() + intervalHours * 3600 * 1000);
      run = await withTenant(apiKeyId, (tx) =>
        tx.agentRun.create({
          data: {
            apiKeyId,
            pillar,
            name: name ?? null,
            status: 'active',
            config: { mailboxId, baselineDailyRampUp: mailbox.warmupConfig!.dailyRampUp },
            intervalHours,
            nextCheckAt,
            createdByEmail: request.apiKey.ownerId ?? null,
          },
          select: AGENT_RUN_SELECT,
        }),
      ) as AgentRunSelectResult;
    } else {
      // Outbound: one-shot, no interval/nextCheckAt, kicked once — and no
      // autoSend option anywhere in this branch (unlike nurture).
      const { leadIds, about, icpContext, fromName, fromEmail, mailboxId, stepCount, sender, tone } = parsed.data;

      const leads = await withTenant(apiKeyId, (tx) => tx.lead.findMany({ where: { apiKeyId, id: { in: leadIds } }, select: { id: true } }));
      if (leads.length === 0) throw Errors.notFound('Leads');
      if (leads.length < leadIds.length) {
        throw Errors.validationFailed({ leadIds: `${leadIds.length - leads.length} of the given leadIds don't belong to this account.` });
      }

      if (mailboxId) {
        const mailbox = await withTenant(apiKeyId, (tx) => tx.mailbox.findFirst({ where: { id: mailboxId, apiKeyId }, select: { id: true } }));
        if (!mailbox) throw Errors.notFound('Mailbox');
      }

      run = await withTenant(apiKeyId, (tx) =>
        tx.agentRun.create({
          data: {
            apiKeyId,
            pillar,
            name: name ?? null,
            status: 'active',
            config: {
              leadIds, about, fromName, fromEmail,
              ...(icpContext !== undefined && { icpContext }),
              ...(mailboxId !== undefined && { mailboxId }),
              ...(stepCount !== undefined && { stepCount }),
              ...(sender !== undefined && { sender }),
              ...(tone !== undefined && { tone }),
            } as unknown as Prisma.InputJsonValue,
            createdByEmail: request.apiKey.ownerId ?? null,
          },
          select: AGENT_RUN_SELECT,
        }),
      ) as AgentRunSelectResult;

      await agentRunQueue.add(
        'agent-run-kick',
        { agentRunId: run.id } as AgentRunKickPayload,
        { jobId: `agent-run-kick-${run.id}-${Date.now()}` },
      );
    }

    logger.info({ agentRunId: run.id, apiKeyId, pillar }, 'Agent run created');
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

  // ── POST /v1/agent-runs/:id/approve ──────────────────────────────────────────
  // Nurture and Outbound only: the human-in-the-loop gate. A drafted run
  // sits at pending_approval until this is called (nurture skips this
  // entirely when config.autoSend was true at creation — outbound has no
  // such option, approval is never optional there) — only after this does
  // the real Campaign/Sequence get created and handed to the existing send
  // worker (campaignWorker.ts / sequenceWorker.ts).
  fastify.post<{ Params: AgentRunParams }>('/agent-runs/:id/approve', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest<{ Params: AgentRunParams }>, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const run = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.findFirst({ where: { id: request.params.id, apiKeyId }, select: { id: true, pillar: true, status: true, config: true } }),
    );
    if (!run) throw Errors.notFound('Agent run');
    if (run.pillar !== 'nurture' && run.pillar !== 'outbound') {
      throw Errors.validationFailed({ pillar: 'Only nurture and outbound agent runs have an approval step.' });
    }
    if (run.status !== 'pending_approval') {
      throw Errors.validationFailed({ status: `Agent run is "${run.status}", not awaiting approval.` });
    }

    if (run.pillar === 'nurture') {
      const cfg = parseNurtureAgentConfig(run.config);
      if (!cfg || !cfg.draft) throw Errors.validationFailed({ config: 'This run has no draft to approve.' });

      const campaignId = await createAndSendCampaignFromDraft(apiKeyId, cfg);
      const updated = await withTenant(apiKeyId, (tx) =>
        tx.agentRun.update({
          where: { id: run.id },
          data: { status: 'completed', completedAt: new Date(), config: { ...(run.config as object), campaignId } },
          select: AGENT_RUN_SELECT,
        }),
      );
      await prisma.agentRunEvent.create({
        data: {
          agentRunId: run.id, eventType: 'sent',
          message: `Approved and sent to ${cfg.draft.matchCount.toLocaleString()} contacts.`,
          data: { campaignId, subject: cfg.draft.subject },
        },
      });
      logger.info({ agentRunId: run.id, apiKeyId, campaignId }, 'Nurture agent run approved and sent');
      return reply.status(200).send({ ...formatAgentRun(updated as AgentRunSelectResult), campaignId });
    }

    // Outbound
    const cfg = parseOutboundAgentConfig(run.config);
    if (!cfg || !cfg.draft) throw Errors.validationFailed({ config: 'This run has no draft to approve.' });

    const { sequenceId, enrolled, skipped, conflicts } = await createSequenceAndEnrollFromDraft(apiKeyId, cfg);
    const updated = await withTenant(apiKeyId, (tx) =>
      tx.agentRun.update({
        where: { id: run.id },
        data: { status: 'completed', completedAt: new Date(), config: { ...(run.config as object), sequenceId } },
        select: AGENT_RUN_SELECT,
      }),
    );
    await prisma.agentRunEvent.create({
      data: {
        agentRunId: run.id, eventType: 'enrolled',
        message: `Approved — ${enrolled} lead(s) enrolled and sending on schedule.${skipped ? ` ${skipped} already enrolled.` : ''}${conflicts ? ` ${conflicts} skipped (already active in another sequence).` : ''}`,
        data: { sequenceId, enrolled, skipped, conflicts },
      },
    });
    logger.info({ agentRunId: run.id, apiKeyId, sequenceId, enrolled }, 'Outbound agent run approved and enrolled');
    return reply.status(200).send({ ...formatAgentRun(updated as AgentRunSelectResult), sequenceId, enrolled, skipped, conflicts });
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

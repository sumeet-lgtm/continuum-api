/**
 * Agent Run Worker
 *
 * Tick loop for the shared cross-pillar `AgentRun` primitive — mechanics
 * copied directly from workers/monitorWorker.ts (due-detection, per-row
 * Redis lock, ±10% jitter, exponential backoff + auto-pause after repeated
 * failures). Verification and Nurture pillars are implemented; the other
 * AgentPillar values are accepted by the schema but not yet processed here
 * — see prisma/schema.prisma and the plan this was built from.
 *
 * Email Verification pillar, per tick (recurring, cron-scheduled):
 *   1. Find contacts on the watched list never verified, or not verified in
 *      `cutoffDays` (default 30).
 *   2. Verify each through the existing engine (verifyEmail — same function
 *      every other verify path uses, no new verification logic).
 *   3. Write Contact.lastVerifiedAt/lastVerificationStatus.
 *   4. If invalid and config.autoRemoveInvalid, quarantine the membership
 *      (status change, never a hard delete).
 *   5. Emit an AgentRunEvent summarizing the tick — this is what the
 *      dashboard's activity feed renders.
 *
 * Nurture pillar (one-shot, kicked once at creation — see processNurtureTick
 * below): draft copy via the existing AI generation flow, then either wait
 * at pending_approval for a human, or (autoSend) hand straight to the
 * existing, already-hardened Campaign/campaignWorker.ts send pipeline.
 */

import { Worker, Queue, type Job } from 'bullmq';
import { redisConnection, QUEUE_AGENT_RUN } from '../lib/queue.js';
import { redis, redisKey } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { withTenant, withRlsBypass } from '../lib/tenantContext.js';
import { verifyEmail } from '../engine/index.js';
import { getPlanLimit, incrementUsageBy } from '../plugins/usageMeter.js';
import { config } from '../config.js';
import { logger, type Logger } from '../lib/logger.js';
import { initSentry, installCrashReporting } from '../lib/sentry.js';
import { parseVerificationAgentConfig, DEFAULT_VERIFICATION_CUTOFF_DAYS, parseNurtureAgentConfig } from '../types/agentRun.js';
import type { AgentRunTickPayload, AgentRunKickPayload } from '../types/job.js';
import { deriveListSegments } from '../lib/campaignSegments.js';
import { generateSegmentEmail } from '../lib/emailGenerator.js';
import { createAndSendCampaignFromDraft } from '../lib/nurtureAgent.js';

const GROWTH_PLANS = new Set(['growth', 'scale']);

if (process.env['NODE_ENV'] !== 'test') {
  initSentry('worker-agent-run');
  installCrashReporting('worker-agent-run');
}

export const TICK_BATCH_SIZE      = 50; // due AgentRuns pulled per tick
export const RUN_CONCURRENCY      = 5;  // due AgentRuns processed in parallel
export const VERIFY_BATCH_SIZE    = 25; // contacts verified per run per tick
export const VERIFY_CONCURRENCY   = 10; // concurrent verifyEmail() calls within a run's batch
export const MAX_CONSECUTIVE_FAILURES = 5;
export const JITTER_FACTOR        = 0.10;
const LOCK_TTL_MS = (config.SMTP_CHECK_TIMEOUT_MS + 8_000) * VERIFY_BATCH_SIZE;

type AgentRunJobData = AgentRunTickPayload | AgentRunKickPayload;

// ─── Tick handler ─────────────────────────────────────────────────────────────

async function runAgentTick(_job: Job<AgentRunTickPayload>): Promise<void> {
  const now = new Date();

  // tenant-sweep: scans due AgentRuns across every tenant; each row's own
  // apiKeyId is used to re-scope every subsequent per-contact operation via
  // withTenant() below, never read/written outside that scope.
  const dueRuns = await withRlsBypass((tx) =>
    tx.agentRun.findMany({
      where: {
        pillar: 'verification',
        status: 'active',
        pausedAt: null,
        nextCheckAt: { lte: now },
      },
      select: { id: true, apiKeyId: true, pillar: true, config: true, intervalHours: true, consecutiveFailures: true },
      orderBy: { nextCheckAt: 'asc' },
      take: TICK_BATCH_SIZE,
    }),
  );

  if (dueRuns.length === 0) {
    logger.debug('Agent run tick: no runs due');
    return;
  }

  logger.info({ count: dueRuns.length }, 'Agent run tick processing');

  for (let i = 0; i < dueRuns.length; i += RUN_CONCURRENCY) {
    const chunk = dueRuns.slice(i, i + RUN_CONCURRENCY);
    await Promise.allSettled(chunk.map((run: typeof dueRuns[number]) => processAgentRun(run)));
  }
}

async function runKick(job: Job<AgentRunKickPayload>): Promise<void> {
  const { agentRunId } = job.data;

  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { id: true, apiKeyId: true, pillar: true, config: true, intervalHours: true, consecutiveFailures: true, status: true, pausedAt: true },
  });

  if (!run) {
    logger.warn({ agentRunId }, 'Kick: agent run not found');
    return;
  }
  if (run.status !== 'active' || run.pausedAt) {
    logger.info({ agentRunId }, 'Kick: agent run is not active — skipping');
    return;
  }

  await processAgentRun(run);
}

async function processJob(job: Job<AgentRunJobData>): Promise<void> {
  if (job.name === 'agent-run-kick') {
    await runKick(job as Job<AgentRunKickPayload>);
  } else {
    await runAgentTick(job as Job<AgentRunTickPayload>);
  }
}

// ─── Per-run dispatch ─────────────────────────────────────────────────────────

interface AgentRunRecord {
  id: string;
  apiKeyId: string;
  pillar: string;
  config: unknown;
  intervalHours: number | null;
  consecutiveFailures: number;
}

async function processAgentRun(run: AgentRunRecord): Promise<void> {
  const lockKey = redisKey.agentRunLock(run.id);
  const lockValue = `worker:${process.pid}:${Date.now()}`;
  const log = logger.child({ agentRunId: run.id, apiKeyId: run.apiKeyId, pillar: run.pillar });

  const acquired = await redis.set(lockKey, lockValue, { nx: true, px: LOCK_TTL_MS });
  if (!acquired) {
    log.debug('Agent run lock not acquired — skipping (another worker processing it)');
    return;
  }

  try {
    if (run.pillar === 'verification') {
      await processVerificationTick(run, log);
    } else if (run.pillar === 'nurture') {
      await processNurtureTick(run, log);
    } else {
      log.error({ pillar: run.pillar }, 'Agent run has an unsupported pillar — no worker implements it yet');
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'failed', errorMessage: `Pillar "${run.pillar}" is not implemented yet.` },
      });
    }
  } finally {
    const current = await redis.get(lockKey);
    if (current === lockValue) {
      await redis.del(lockKey);
    }
  }
}

// ─── Verification pillar tick ──────────────────────────────────────────────────

async function processVerificationTick(
  run: AgentRunRecord,
  log: Logger,
): Promise<void> {
  const intervalHours = run.intervalHours ?? 24;
  const cfg = parseVerificationAgentConfig(run.config);

  if (!cfg) {
    log.error({ config: run.config }, 'Agent run has invalid config — pausing');
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'failed', errorMessage: 'Invalid or missing verification config (listId required)', pausedAt: new Date() },
    });
    return;
  }

  try {
    const key = await prisma.apiKey.findUnique({
      where: { id: run.apiKeyId },
      select: { plan: true, monthlyLimit: true, currentMonthUsage: true, extraVerificationCredits: true },
    });

    const quotaLimit = key ? getPlanLimit(key.plan, key.monthlyLimit) + (key.extraVerificationCredits ?? 0) : 0;
    const quotaRemaining = key ? Math.max(0, quotaLimit - key.currentMonthUsage) : 0;

    if (quotaRemaining <= 0) {
      log.info({ apiKeyId: run.apiKeyId }, 'Monthly quota exhausted — rescheduling verification agent run');
      const nextCheckAt = calcNextCheckAt(intervalHours);
      await prisma.agentRun.update({ where: { id: run.id }, data: { nextCheckAt } });
      await emitEvent(run.id, 'quota_exhausted', 'Monthly verification quota exhausted — will retry next tick.');
      return;
    }

    const batchCap = Math.min(VERIFY_BATCH_SIZE, quotaRemaining);
    const cutoffDate = new Date(Date.now() - (cfg.cutoffDays ?? DEFAULT_VERIFICATION_CUTOFF_DAYS) * 86_400_000);

    const due = await withTenant(run.apiKeyId, async (tx) => {
      const neverVerified = await tx.contactListMembership.findMany({
        where: {
          listId: cfg.listId,
          status: 'subscribed',
          contact: { apiKeyId: run.apiKeyId, lastVerifiedAt: null },
        },
        include: { contact: true },
        take: batchCap,
      });

      if (neverVerified.length >= batchCap) return neverVerified;

      const stale = await tx.contactListMembership.findMany({
        where: {
          listId: cfg.listId,
          status: 'subscribed',
          contact: { apiKeyId: run.apiKeyId, lastVerifiedAt: { lt: cutoffDate } },
        },
        include: { contact: true },
        orderBy: { contact: { lastVerifiedAt: 'asc' } },
        take: batchCap - neverVerified.length,
      });

      return [...neverVerified, ...stale];
    });

    if (due.length === 0) {
      const nextCheckAt = calcNextCheckAt(intervalHours);
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { lastCheckedAt: new Date(), nextCheckAt, consecutiveFailures: 0 },
      });
      await emitEvent(run.id, 'tick_complete', 'Watched list checked — no contacts due for (re)verification.');
      return;
    }

    const counts = { valid: 0, invalid: 0, risky: 0, unknown: 0, quarantined: 0, errored: 0 };

    for (let i = 0; i < due.length; i += VERIFY_CONCURRENCY) {
      const chunk = due.slice(i, i + VERIFY_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (membership: typeof due[number]) => {
          const result = await verifyEmail({
            email: membership.contact.email,
            apiKeyId: run.apiKeyId,
            bulkJobId: undefined,
            sourceIp: undefined,
          });
          return { membership, result };
        }),
      );

      for (const s of settled) {
        if (s.status === 'rejected') {
          counts.errored++;
          log.warn({ err: s.reason }, 'Verification agent: engine error on one contact');
          continue;
        }
        const { membership, result } = s.value;
        counts[result.status]++;

        await withTenant(run.apiKeyId, async (tx) => {
          await tx.contact.update({
            where: { id: membership.contactId },
            data: { lastVerifiedAt: new Date(), lastVerificationStatus: result.status },
          });

          if (result.status === 'invalid' && cfg.autoRemoveInvalid) {
            await tx.contactListMembership.update({
              where: { id: membership.id },
              data: { status: 'quarantined' },
            });
            counts.quarantined++;
          }
        });
      }
    }

    const verifiedCount = due.length - counts.errored;
    if (verifiedCount > 0) {
      await incrementUsageBy(run.apiKeyId, verifiedCount);
    }

    const nextCheckAt = calcNextCheckAt(intervalHours);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { lastCheckedAt: new Date(), nextCheckAt, consecutiveFailures: 0 },
    });

    const parts = [`Verified ${verifiedCount}`, `${counts.valid} valid`];
    if (counts.risky) parts.push(`${counts.risky} risky`);
    if (counts.unknown) parts.push(`${counts.unknown} unknown`);
    if (counts.invalid) parts.push(`${counts.invalid} invalid`);
    if (counts.quarantined) parts.push(`quarantined ${counts.quarantined}`);
    if (counts.errored) parts.push(`${counts.errored} errored`);

    await emitEvent(run.id, 'verified', parts.join(', '), counts);

    log.info({ ...counts, listId: cfg.listId }, 'Verification agent tick complete');
  } catch (err) {
    await handleTickFailure(run, intervalHours, err, log);
  }
}

async function handleTickFailure(
  run: AgentRunRecord,
  intervalHours: number,
  err: unknown,
  log: Logger,
): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : 'Unknown error';
  log.error({ err }, 'Agent run tick failed');

  const fresh = await prisma.agentRun.findUnique({
    where: { id: run.id },
    select: { consecutiveFailures: true },
  });
  const newFailures = (fresh?.consecutiveFailures ?? 0) + 1;
  const shouldPause = newFailures >= MAX_CONSECUTIVE_FAILURES;

  const backoffHours = Math.min(intervalHours * Math.pow(2, newFailures), 24);
  const nextCheckAt = new Date(Date.now() + backoffHours * 3600 * 1000);

  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      nextCheckAt,
      consecutiveFailures: newFailures,
      errorMessage: errorMsg.slice(0, 500),
      ...(shouldPause && { pausedAt: new Date(), status: 'paused' }),
    },
  });

  await emitEvent(run.id, 'error', `Tick failed: ${errorMsg.slice(0, 200)}`);

  if (shouldPause) {
    log.warn({ consecutiveFailures: newFailures }, 'Agent run auto-paused after too many consecutive failures');
    await emitEvent(run.id, 'auto_paused', `Auto-paused after ${newFailures} consecutive failures. Fix the issue and resume.`);
  }
}

// ─── Nurture pillar (one-shot: draft → approve → send) ─────────────────────────
// Not tick-scheduled — only ever reached via the 'agent-run-kick' job fired
// once at creation (and again from POST /:id/approve if a future retry path
// needs it), never by runAgentTick's due-detection sweep (which filters
// pillar: 'verification' only).

async function processNurtureTick(run: AgentRunRecord, log: Logger): Promise<void> {
  const cfg = parseNurtureAgentConfig(run.config);
  if (!cfg) {
    log.error({ config: run.config }, 'Agent run has invalid config — failing');
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'failed', errorMessage: 'Invalid or missing nurture config (listId, about, fromName, fromEmail required)' },
    });
    return;
  }

  // Idempotency: a stray re-kick of a run that already drafted or sent
  // should never re-generate or re-send.
  if (cfg.campaignId) return;
  if (cfg.draft) {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'pending_approval' } });
    return;
  }

  try {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'running', startedAt: new Date() } });

    const key = await prisma.apiKey.findUnique({ where: { id: run.apiKeyId }, select: { plan: true } });
    if (!GROWTH_PLANS.has(key?.plan ?? 'free')) {
      throw new Error('The Nurture Agent requires a Growth or Scale plan (same gate as AI campaign copy generation).');
    }
    if (!config.AI_PERSONALIZATION_ENABLED) throw new Error('AI features are not enabled on this account.');
    const anthropicKey = config.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw new Error('AI copy generation is not configured on this deployment.');

    const { totalContacts, segments } = await deriveListSegments(run.apiKeyId, [cfg.listId], 1);
    if (totalContacts === 0 || segments.length === 0 || !segments[0]) {
      throw new Error('This list has no subscribed contacts to draft for.');
    }
    const segment = segments[0];

    const email = await generateSegmentEmail(anthropicKey, {
      about: cfg.about,
      segment,
      ...(cfg.sender !== undefined && { sender: cfg.sender }),
      ...(cfg.tone !== undefined && { tone: cfg.tone }),
    });
    await incrementUsageBy(run.apiKeyId, 1);

    const draft = {
      subject: email.subject,
      htmlBody: email.htmlBody,
      textBody: email.textBody,
      segmentLabel: email.segmentLabel,
      matchCount: email.matchCount,
    };
    const newConfig = { ...(run.config as object), draft };

    if (cfg.autoSend) {
      const campaignId = await createAndSendCampaignFromDraft(run.apiKeyId, { ...cfg, draft });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'completed', completedAt: new Date(), config: { ...newConfig, campaignId } },
      });
      await emitEvent(run.id, 'sent', `Drafted and sent to ${draft.matchCount.toLocaleString()} contacts (auto-send enabled).`, { campaignId, subject: draft.subject });
      log.info({ listId: cfg.listId, campaignId }, 'Nurture agent auto-sent');
    } else {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'pending_approval', config: newConfig },
      });
      await emitEvent(
        run.id,
        'drafted',
        `Draft ready for ${draft.matchCount.toLocaleString()} contacts — review and approve to send.`,
        { subject: draft.subject, preview: draft.textBody.slice(0, 280) },
      );
      log.info({ listId: cfg.listId, matchCount: draft.matchCount }, 'Nurture agent draft ready for approval');
    }
  } catch (err) {
    await handleNurtureFailure(run, err, log);
  }
}

async function handleNurtureFailure(run: AgentRunRecord, err: unknown, log: Logger): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : 'Unknown error';
  log.error({ err }, 'Nurture agent run failed');
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: 'failed', errorMessage: errorMsg.slice(0, 500) },
  });
  await emitEvent(run.id, 'error', `Draft failed: ${errorMsg.slice(0, 200)}`);
}

async function emitEvent(
  agentRunId: string,
  eventType: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.agentRunEvent.create({
      data: { agentRunId, eventType, message, data: data ? (data as any) : undefined },
    });
  } catch (err) {
    logger.warn({ err, agentRunId }, 'Failed to write agent run event');
  }
}

// ─── Scheduling helpers ───────────────────────────────────────────────────────

export function calcNextCheckAt(intervalHours: number): Date {
  const baseMs = intervalHours * 3600 * 1000;
  const jitterMs = baseMs * JITTER_FACTOR;
  const offsetMs = (Math.random() * 2 - 1) * jitterMs;
  return new Date(Date.now() + baseMs + offsetMs);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function startAgentRunWorker(): { close: () => Promise<void> } {
  const agentRunQueue = new Queue<AgentRunJobData>(QUEUE_AGENT_RUN, {
    connection: redisConnection,
  });

  void agentRunQueue.add(
    'agent-run-tick',
    { batchSize: TICK_BATCH_SIZE },
    {
      repeat: { pattern: '*/5 * * * *' },
      jobId: 'agent-run-tick-repeatable',
    },
  );

  const worker = new Worker<AgentRunJobData>(QUEUE_AGENT_RUN, processJob, {
    connection: redisConnection,
    concurrency: 1, // one tick at a time; parallelism is inside runAgentTick
    stalledInterval: 120_000,
    maxStalledCount: 2,
  });

  worker.on('completed', (job) => {
    logger.debug({ bullJobId: job.id, name: job.name }, 'Agent run job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ bullJobId: job?.id, name: job?.name, err }, 'Agent run job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Agent run worker error');
  });

  logger.info('Agent run worker started — cron tick every 5 minutes');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Agent run worker shutting down');
    await worker.close();
    await agentRunQueue.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return { close: () => worker.close() };
}

export { startAgentRunWorker };
if (process.env['NODE_ENV'] !== 'test') {
  startAgentRunWorker();
}

/**
 * Monitor Worker
 *
 * Two job types processed from the `continuum:monitor` queue:
 *
 *   monitor-tick       — repeatable cron, every 5 minutes
 *                        Fetches all due monitors (nextCheckAt <= now, active, not paused)
 *                        and verifies them in parallel chunks.
 *
 *   recheck-single     — enqueued by POST /v1/monitoring/:id/recheck
 *                        Immediately processes a single specific monitor.
 *
 * Per-monitor logic:
 *   1. Acquire a Redis lock (NX PX) — prevents duplicate processing across workers
 *   2. Run the verification engine
 *   3. Write a MonitorCheck record with source, durationMs, statusChanged
 *   4. Update Monitor.lastCheckedAt, nextCheckAt, lastStatus
 *   5. Reset consecutiveFailures on success; increment on failure
 *   6. Auto-pause monitor after MAX_CONSECUTIVE_FAILURES engine errors
 *   7. Dispatch webhook if statusChanged AND notifyOnAnyChange=true
 *
 * Jitter:
 *   nextCheckAt is randomised ±10% of intervalHours to spread load across ticks
 *   and prevent a thundering herd when many monitors share the same interval.
 */

import { Worker, Queue, type Job } from 'bullmq';
import { redisConnection, QUEUE_MONITOR, webhookQueue, disposableListQueue } from '../lib/queue.js';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { verifyEmail } from '../engine/index.js';
import { getPlanLimit, incrementUsageBy } from '../plugins/usageMeter.js';
import { runEmailSweep } from './emailSweep.js';
import { loadDisposableList } from '../engine/disposable.js';
import { startDisposableListWorker, scheduleDisposableListRefresh } from './disposableListWorker.js';
import { config } from '../config.js';
import { dispatchWebhook, buildEventId } from '../lib/webhooks.js';
import { logger } from '../lib/logger.js';
import { initSentry, installCrashReporting } from '../lib/sentry.js';
import type { MonitorCheckPayload } from '../types/job.js';
import type { VerificationStatus } from '../types/verification.js';

if (process.env['NODE_ENV'] !== 'test') {
  initSentry('worker-monitor');
  installCrashReporting('worker-monitor');
}

export const BATCH_SIZE             = 50;
const MONITOR_CONCURRENCY    = 5;
export const MAX_CONSECUTIVE_FAILURES = 5;   // auto-pause after this many back-to-back engine errors
const LOCK_TTL_MS            = (config.SMTP_CHECK_TIMEOUT_MS + 8_000) * 2;
export const JITTER_FACTOR          = 0.10; // ±10% of interval

// ─── Job type union ───────────────────────────────────────────────────────────

type MonitorJobData =
  | MonitorCheckPayload                          // monitor-tick
  | { monitorId: string; source: string };       // recheck-single

// ─── Tick handler ─────────────────────────────────────────────────────────────

async function runMonitorTick(_job: Job<MonitorCheckPayload>): Promise<void> {
  const now = new Date();

  const dueMonitors = await prisma.monitor.findMany({
    where: {
      isActive:   true,
      pausedAt:   null,
      nextCheckAt: { lte: now },
    },
    select: {
      id:               true,
      email:            true,
      apiKeyId:         true,
      intervalHours:    true,
      lastStatus:       true,
      notifyOnAnyChange: true,
    },
    orderBy: { nextCheckAt: 'asc' },
    take:    BATCH_SIZE,
  });

  if (dueMonitors.length === 0) {
    logger.debug('Monitor tick: no monitors due');
    return;
  }

  logger.info({ count: dueMonitors.length }, 'Monitor tick processing');

  for (let i = 0; i < dueMonitors.length; i += MONITOR_CONCURRENCY) {
    const chunk = dueMonitors.slice(i, i + MONITOR_CONCURRENCY);
    await Promise.allSettled(
      chunk.map((m: typeof dueMonitors[number]) =>
        processMonitor({
          id:               m.id,
          email:            m.email,
          apiKeyId:         m.apiKeyId,
          intervalHours:    m.intervalHours,
          lastStatus:       m.lastStatus,
          notifyOnAnyChange: m.notifyOnAnyChange,
          source:           'scheduled',
        }),
      ),
    );
  }
}

// ─── Recheck handler ──────────────────────────────────────────────────────────

async function runRecheckSingle(job: Job<{ monitorId: string; source: string }>): Promise<void> {
  const { monitorId, source } = job.data;

  const monitor = await prisma.monitor.findUnique({
    where:  { id: monitorId },
    select: {
      id:                true,
      email:             true,
      apiKeyId:          true,
      intervalHours:     true,
      lastStatus:        true,
      notifyOnAnyChange: true,
      isActive:          true,
      pausedAt:          true,
    },
  });

  if (!monitor) {
    logger.warn({ monitorId }, 'Recheck: monitor not found');
    return;
  }

  if (!monitor.isActive) {
    logger.info({ monitorId }, 'Recheck: monitor is inactive — skipping');
    return;
  }

  await processMonitor({
    id:               monitor.id,
    email:            monitor.email,
    apiKeyId:         monitor.apiKeyId,
    intervalHours:    monitor.intervalHours,
    lastStatus:       monitor.lastStatus,
    notifyOnAnyChange: monitor.notifyOnAnyChange,
    source:           source ?? 'manual_recheck',
  });
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

async function processJob(job: Job<MonitorJobData>): Promise<void> {
  if (job.name === 'recheck-single') {
    await runRecheckSingle(job as Job<{ monitorId: string; source: string }>);
  } else {
    await runMonitorTick(job as Job<MonitorCheckPayload>);
  }
}

// ─── Per-monitor verification ─────────────────────────────────────────────────

interface MonitorRecord {
  id:               string;
  email:            string;
  apiKeyId:         string;
  intervalHours:    number;
  lastStatus:       string | null;
  notifyOnAnyChange: boolean;
  source:           string;
}

async function processMonitor(monitor: MonitorRecord): Promise<void> {
  const lockKey   = `lock:monitor:${monitor.id}`;
  const lockValue = `worker:${process.pid}:${Date.now()}`;
  const log       = logger.child({ monitorId: monitor.id, email: monitor.email });

  // Distributed lock — prevents double-checking when multiple workers run
  const acquired = await redis.set(lockKey, lockValue, { nx: true, px: LOCK_TTL_MS });
  if (!acquired) {
    log.debug('Monitor lock not acquired — skipping (another worker processing it)');
    return;
  }

  const wallStart = Date.now();

  try {
    log.debug({ source: monitor.source }, 'Running monitor check');

    // Monitor checks consume verifications (and provider credits) — skip when
    // the key is over its monthly quota, rescheduling instead of burning credits.
    const key = await prisma.apiKey.findUnique({
      where:  { id: monitor.apiKeyId },
      select: { plan: true, monthlyLimit: true, currentMonthUsage: true },
    });
    if (key && key.currentMonthUsage >= getPlanLimit(key.plan, key.monthlyLimit)) {
      log.info({ apiKeyId: monitor.apiKeyId }, 'Monthly quota exhausted — skipping monitor check');
      await prisma.monitor.update({
        where: { id: monitor.id },
        data:  { nextCheckAt: calcNextCheckAt(monitor.intervalHours) },
      });
      return;
    }

    const result = await verifyEmail({
      email:     monitor.email,
      apiKeyId:  monitor.apiKeyId,
      bulkJobId: undefined,
      sourceIp:  undefined,
    });

    // Each successful check counts toward the key's monthly quota
    await incrementUsageBy(monitor.apiKeyId, 1);

    const durationMs      = Date.now() - wallStart;
    const newStatus       = result.status;
    const previousStatus  = monitor.lastStatus as VerificationStatus | null;
    const statusChanged   = newStatus !== previousStatus;
    const checkedAt       = new Date();
    const nextCheckAt     = calcNextCheckAt(monitor.intervalHours);

    // Write the MonitorCheck record
    await prisma.monitorCheck.create({
      data: {
        monitorId:      monitor.id,
        verificationId: result.id,
        statusChanged,
        previousStatus: previousStatus ?? null,
        newStatus,
        source:         monitor.source,
        checkedAt,
        durationMs,
        webhookSent:    false,
      },
    });

    // Update the monitor: reset failures, advance schedule
    await prisma.monitor.update({
      where: { id: monitor.id },
      data: {
        lastCheckedAt:       checkedAt,
        nextCheckAt,
        lastStatus:          newStatus,
        consecutiveFailures: 0,  // success → reset
        failureReason:       null,
      },
    });

    log.info(
      { newStatus, previousStatus, statusChanged, durationMs, nextCheckAt },
      'Monitor check complete',
    );

    // Dispatch webhook on status change (if the monitor is configured to notify)
    if (statusChanged && monitor.notifyOnAnyChange) {
      await dispatchStatusChangeWebhooks(monitor, newStatus, previousStatus, checkedAt);
    }

  } catch (err) {
    const durationMs  = Date.now() - wallStart;
    const errorMsg    = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, durationMs }, 'Monitor check failed');

    // Fetch current failure count atomically
    const fresh = await prisma.monitor.findUnique({
      where:  { id: monitor.id },
      select: { consecutiveFailures: true },
    });
    const newFailures = (fresh?.consecutiveFailures ?? 0) + 1;
    const shouldPause = newFailures >= MAX_CONSECUTIVE_FAILURES;

    // Exponential backoff: 2^failures × interval, capped at 24 hours
    const backoffHours = Math.min(
      monitor.intervalHours * Math.pow(2, newFailures),
      24,
    );
    const nextCheckAt = new Date(Date.now() + backoffHours * 3600 * 1000);

    await prisma.monitor.update({
      where: { id: monitor.id },
      data: {
        nextCheckAt,
        consecutiveFailures: newFailures,
        failureReason:       errorMsg.slice(0, 500),
        ...(shouldPause && {
          pausedAt: new Date(),
          isActive: false,
        }),
      },
    });

    if (shouldPause) {
      log.warn(
        { consecutiveFailures: newFailures, max: MAX_CONSECUTIVE_FAILURES },
        'Monitor auto-paused after too many consecutive failures',
      );
    }
  } finally {
    // Release the lock only if we still own it
    const current = await redis.get(lockKey);
    if (current === lockValue) {
      await redis.del(lockKey);
    }
  }
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

async function dispatchStatusChangeWebhooks(
  monitor: MonitorRecord,
  newStatus:      VerificationStatus,
  previousStatus: VerificationStatus | null,
  checkedAt:      Date,
): Promise<void> {
  // Use a stable eventId so duplicate dispatches don't double-deliver
  const eventId = buildEventId('email.status_changed', `${monitor.id}:${checkedAt.toISOString()}`);

  await dispatchWebhook({
    apiKeyId: monitor.apiKeyId,
    event:    'email.status_changed',
    eventId,
    payload: {
      event:          'email.status_changed',
      monitorId:      monitor.id,
      email:          monitor.email,
      previousStatus: previousStatus ?? null,
      newStatus,
      source:         monitor.source,
      checkedAt:      checkedAt.toISOString(),
      apiVersion:     '2',
    },
  });

  // Mark the MonitorCheck row as webhookSent
  await prisma.monitorCheck.updateMany({
    where: {
      monitorId:   monitor.id,
      checkedAt:   { gte: checkedAt },
      webhookSent: false,
    },
    data: { webhookSent: true },
  });
}

// ─── Scheduling helpers ───────────────────────────────────────────────────────

/**
 * Calculate the next check time with ±JITTER_FACTOR jitter applied.
 * Jitter prevents a thundering herd when many monitors share the same interval.
 *
 * Example for 24h interval:
 *   Base = 24 * 3600 * 1000 = 86_400_000 ms
 *   Jitter range = ±8_640_000 ms (±10%)
 *   Actual next check = 86_400_000 ± random(0..8_640_000)
 */
export function calcNextCheckAt(intervalHours: number): Date {
  const baseMs    = intervalHours * 3600 * 1000;
  const jitterMs  = baseMs * JITTER_FACTOR;
  const offsetMs  = (Math.random() * 2 - 1) * jitterMs; // ±jitterMs
  return new Date(Date.now() + baseMs + offsetMs);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────


// ─── Monthly usage reset ──────────────────────────────────────────────────────

async function resetMonthlyUsage(): Promise<void> {
  const now = new Date();
  try {
    const result = await prisma.apiKey.updateMany({
      where: {
        usageResetAt: { lte: now },
        isActive: true,
      },
      data: {
        currentMonthUsage: 0,
        usageResetAt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      },
    });
    if (result.count > 0) {
      logger.info({ count: result.count }, 'Monthly usage reset complete');
    }
  } catch (err) {
    logger.error({ err }, 'Monthly usage reset failed');
  }
}

// ─── Provider credit alarm ────────────────────────────────────────────────────
// The Redis outage in June went unnoticed for two weeks; credits running dry
// would fail the same silent way. Checked twice a day; alerts via log +
// optional ALERT_WEBHOOK_URL (Slack-compatible {text} payload).

const CREDIT_ALERT_THRESHOLD = Number(process.env['CREDIT_ALERT_THRESHOLD'] ?? 5_000);

async function checkProviderCredits(): Promise<void> {
  const apiKey = config.DEBOUNCE_API_KEY;
  if (!apiKey) return;
  try {
    const res = await fetch(`https://api.debounce.io/v1/balance/?api=${apiKey}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { balance?: string };
    const balance = Number(data.balance ?? NaN);
    if (!Number.isFinite(balance)) return;

    logger.info({ balance }, 'DeBounce credit balance');
    if (balance < CREDIT_ALERT_THRESHOLD) {
      logger.error(
        { balance, threshold: CREDIT_ALERT_THRESHOLD },
        'LOW DEBOUNCE CREDITS — SMTP verification will degrade to unknown when exhausted',
      );
      const hook = process.env['ALERT_WEBHOOK_URL'];
      if (hook) {
        await fetch(hook, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text: `⚠️ Continuum: DeBounce balance is ${balance} credits (threshold ${CREDIT_ALERT_THRESHOLD}). Top up before SMTP checks stop.`,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => { /* alert delivery is best-effort */ });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Provider credit balance check failed');
  }
}

function startMonitorWorker(): void {
  loadDisposableList();

  // Register the repeatable cron tick
  const monitorQueue = new Queue<MonitorCheckPayload>(QUEUE_MONITOR, {
    connection: redisConnection,
  });

  void monitorQueue.add(
    'monitor-tick',
    { batchSize: BATCH_SIZE },
    {
      repeat:  { pattern: '*/5 * * * *' },
      jobId:   'monitor-tick-repeatable',
    },
  );

  const worker = new Worker<MonitorJobData>(QUEUE_MONITOR, processJob, {
    connection:     redisConnection,
    concurrency:    1,  // One tick at a time; parallelism is inside runMonitorTick
    stalledInterval: 120_000,
    maxStalledCount: 2,
  });

  worker.on('completed', (job) => {
    logger.debug({ bullJobId: job.id, name: job.name }, 'Monitor job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ bullJobId: job?.id, name: job?.name, err }, 'Monitor job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Monitor worker error');
  });

  logger.info('Monitor worker started — cron tick every 5 minutes');

  // Check for monthly usage resets every hour
  setInterval(() => { void resetMonthlyUsage(); }, 3_600_000);
  void resetMonthlyUsage(); // Run on startup too

  // Provider credit alarm — twice a day + on startup
  setInterval(() => { void checkProviderCredits(); }, 43_200_000);
  void checkProviderCredits();

  // Lifecycle emails (welcome / quota warnings) — hourly + on startup
  setInterval(() => { void runEmailSweep(); }, 3_600_000);
  void runEmailSweep();

  // Disposable-domain blocklist — refresh from upstream weekly so it doesn't
  // go stale (this worker already owns loadDisposableList() at boot above).
  // Idempotent (fixed jobId), safe to call on every restart.
  const disposableListWorker = startDisposableListWorker();
  void scheduleDisposableListRefresh(disposableListQueue).catch((err: unknown) => {
    logger.error({ err }, 'Failed to schedule disposable list refresh');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Monitor worker shutting down');
    await worker.close();
    await disposableListWorker.close();
    await monitorQueue.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

// Do not auto-start in test environment (NODE_ENV=test is set by global test setup).
// In production and development this runs immediately as the worker entry point.
export { startMonitorWorker };
if (process.env['NODE_ENV'] !== 'test') {
  startMonitorWorker();
}

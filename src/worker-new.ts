import { startCampaignWorker } from './workers/campaignWorker.js';
import { startSequenceWorker, scheduleSequenceTicks } from './workers/sequenceWorker.js';
import { startWarmupWorker, scheduleWarmupTicks } from './workers/warmupWorker.js';
import { startImapWorker, scheduleImapTicks } from './workers/imapWorker.js';
import { runAutomationWorker } from './workers/automationWorker.js';
import { sequenceQueue, warmupQueue, imapQueue } from './lib/queue.js';

const closable: Array<{ close(): Promise<void> }> = [];

closable.push(startCampaignWorker());
closable.push(startSequenceWorker());

// Schedule recurring sequence ticks (every 5 minutes) — idempotent, safe to call on every restart
void scheduleSequenceTicks(sequenceQueue).catch((err: unknown) => {
  console.error('[worker-new] failed to schedule sequence ticks:', err);
});

if (process.env['WARMUP_POOL_ENABLED'] === 'true') {
  closable.push(startWarmupWorker());

  // Schedule recurring warmup ticks (hourly) — without this the warmup
  // worker above starts and listens forever, but nothing ever enqueues a
  // job for it to process, so warmup silently never actually runs.
  // Idempotent (fixed jobId), safe to call on every restart.
  void scheduleWarmupTicks(warmupQueue).catch((err: unknown) => {
    console.error('[worker-new] failed to schedule warmup ticks:', err);
  });
}

if (process.env['IMAP_POLL_ENABLED'] === 'true') {
  closable.push(startImapWorker());

  // Same gap as warmup above: the worker starts and listens, but without
  // this nothing ever enqueues a poll job — reply detection, bounce, and
  // unsubscribe-via-IMAP silently never ran.
  void scheduleImapTicks(imapQueue).catch((err: unknown) => {
    console.error('[worker-new] failed to schedule IMAP ticks:', err);
  });
}

// Automation worker runs every 5 minutes via setInterval
const automationInterval = setInterval(() => {
  runAutomationWorker().catch((err: unknown) => {
    console.error('[automation-worker] error:', err);
  });
}, 5 * 60 * 1000);
// Run once immediately on startup
void runAutomationWorker().catch((err: unknown) => {
  console.error('[automation-worker] startup error:', err);
});

closable.push({ close: async () => { clearInterval(automationInterval); } });

console.log('[worker-new] campaign + sequence + warmup + IMAP + automation workers started');

const shutdown = async () => {
  console.log('[worker-new] shutting down...');
  // allSettled, not all — one worker's close() rejecting must not stop the
  // rest from closing, and must not turn a clean shutdown into a crash.
  await Promise.allSettled(closable.map(w => w.close()));
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (reason) => {
  console.error('[worker-new] unhandled rejection:', reason);
  process.exit(1);
});

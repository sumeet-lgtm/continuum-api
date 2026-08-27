import { startCampaignWorker } from './workers/campaignWorker.js';
import { startSequenceWorker, scheduleSequenceTicks } from './workers/sequenceWorker.js';
import { startWarmupWorker } from './workers/warmupWorker.js';
import { startImapWorker } from './workers/imapWorker.js';
import { runAutomationWorker } from './workers/automationWorker.js';
import { sequenceQueue } from './lib/queue.js';

const closable: Array<{ close(): Promise<void> }> = [];

closable.push(startCampaignWorker());
closable.push(startSequenceWorker());

// Schedule recurring sequence ticks (every 5 minutes) — idempotent, safe to call on every restart
void scheduleSequenceTicks(sequenceQueue).catch((err: unknown) => {
  console.error('[worker-new] failed to schedule sequence ticks:', err);
});

if (process.env['WARMUP_POOL_ENABLED'] === 'true') {
  closable.push(startWarmupWorker());
}

if (process.env['IMAP_POLL_ENABLED'] === 'true') {
  closable.push(startImapWorker());
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
  await Promise.all(closable.map(w => w.close()));
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

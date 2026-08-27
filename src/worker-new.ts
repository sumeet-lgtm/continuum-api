import { startCampaignWorker } from './workers/campaignWorker.js';
import { startSequenceWorker } from './workers/sequenceWorker.js';
import { startWarmupWorker } from './workers/warmupWorker.js';
import { startImapWorker } from './workers/imapWorker.js';

const closable: Array<{ close(): Promise<void> }> = [];

closable.push(startCampaignWorker());
closable.push(startSequenceWorker());

if (process.env['WARMUP_POOL_ENABLED'] === 'true') {
  closable.push(startWarmupWorker());
}

if (process.env['IMAP_POLL_ENABLED'] === 'true') {
  closable.push(startImapWorker());
}

console.log('[worker-new] campaign + sequence + warmup + IMAP workers started');

const shutdown = async () => {
  console.log('[worker-new] shutting down...');
  await Promise.all(closable.map(w => w.close()));
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

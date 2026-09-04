import { logger } from './lib/logger.js';
import { loadDisposableList } from './engine/disposable.js';
import { startBulkWorker } from './workers/bulkWorker.js';
import { startMonitorWorker } from './workers/monitorWorker.js';
import { startWebhookWorker } from './workers/webhookWorker.js';
import { startCampaignWorker } from './workers/campaignWorker.js';
import { startSequenceWorker, scheduleSequenceTicks } from './workers/sequenceWorker.js';
import { startWarmupWorker, scheduleWarmupTicks } from './workers/warmupWorker.js';
import { startImapWorker, scheduleImapTicks } from './workers/imapWorker.js';
import { startDailyChecksWorker, scheduleDailyChecks, QUEUE_DAILY } from './workers/scheduledChecks.js';
import { startSalesforceSyncWorker, scheduleSalesforceSyncTicks } from './workers/salesforceSyncWorker.js';
import { QUEUE_SEQUENCE, QUEUE_WARMUP, QUEUE_IMAP, QUEUE_SALESFORCE_SYNC, closeQueues, redisConnection } from './lib/queue.js';
import { isSalesforceOAuthConfigured } from './lib/oauth/salesforce.js';
import { Queue } from 'bullmq';
import { disconnectPrisma } from './lib/prisma.js';

async function main(): Promise<void> {
  loadDisposableList();

  // These workers manage their own lifecycle internally (void return)
  startBulkWorker();
  startMonitorWorker();
  startWebhookWorker();

  // New workers with closable handles
  const closable: Array<{ close(): Promise<void> }> = [];
  closable.push(startCampaignWorker());
  closable.push(startSequenceWorker());

  const sequenceQueue = new Queue(QUEUE_SEQUENCE, { connection: redisConnection });
  await scheduleSequenceTicks(sequenceQueue);

  if (process.env['WARMUP_POOL_ENABLED'] === 'true') {
    closable.push(startWarmupWorker());
    const warmupQueue = new Queue(QUEUE_WARMUP, { connection: redisConnection });
    await scheduleWarmupTicks(warmupQueue);
    logger.info('Warmup worker started');
  }

  if (process.env['IMAP_POLL_ENABLED'] === 'true') {
    closable.push(startImapWorker());
    const imapQueue = new Queue(QUEUE_IMAP, { connection: redisConnection });
    await scheduleImapTicks(imapQueue);
    logger.info('IMAP polling worker started');
  }

  // Daily scheduled checks: key expiry warnings + auto-revoke expired keys
  closable.push(startDailyChecksWorker());
  const dailyQueue = new Queue(QUEUE_DAILY, { connection: redisConnection });
  await scheduleDailyChecks(dailyQueue);

  // Salesforce sync runs whenever the Connected App is configured — unlike
  // warmup/IMAP there's no separate risk-of-abuse reason to gate it behind
  // its own flag; no customer connection means the tick finds nothing to do.
  if (isSalesforceOAuthConfigured()) {
    closable.push(startSalesforceSyncWorker());
    const salesforceSyncQueue = new Queue(QUEUE_SALESFORCE_SYNC, { connection: redisConnection });
    await scheduleSalesforceSyncTicks(salesforceSyncQueue);
    logger.info('Salesforce sync worker started');
  }

  logger.info('All workers started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
    await Promise.allSettled(closable.map(w => w.close()));
    await Promise.allSettled([
      disconnectPrisma(),
      closeQueues(),
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    // Job-level rejections must not crash the worker process — BullMQ retries them.
    logger.error({ reason }, 'Unhandled rejection in worker process (worker kept alive)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker process — exiting');
    process.exit(1);
  });
}

void main();

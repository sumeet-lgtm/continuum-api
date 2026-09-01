import { Worker, type Job } from 'bullmq';
import { redisConnection, QUEUE_DISPOSABLE_LIST } from '../lib/queue.js';
import { refreshDisposableList } from '../lib/disposableListRefresh.js';
import { reloadDisposableList, getBlocklistStats } from '../engine/disposable.js';
import { logger } from '../lib/logger.js';

async function refreshTick(): Promise<void> {
  const { domains } = await refreshDisposableList();
  reloadDisposableList();
  const stats = getBlocklistStats();
  logger.info(
    { fetched: domains, exact: stats.exact, wildcard: stats.wildcard },
    'Disposable domain blocklist refreshed from upstream',
  );
}

export function startDisposableListWorker(): Worker {
  const worker = new Worker(
    QUEUE_DISPOSABLE_LIST,
    async (_job: Job) => {
      await refreshTick();
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Disposable domain blocklist refresh failed');
  });

  return worker;
}

export async function scheduleDisposableListRefresh(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 7 * 24 * 60 * 60 * 1000 }, // weekly
    jobId: 'disposable-list-refresh-repeat',
  });
}

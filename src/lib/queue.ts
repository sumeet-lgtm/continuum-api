import { Queue, type ConnectionOptions } from 'bullmq';
import { config } from '../config.js';
import type { BulkJobPayload, MonitorCheckPayload, MonitorRecheckPayload } from '../types/job.js';
import type { WebhookDeliveryPayload } from '../types/webhook.js';

// Parse the Redis URL to extract connection details for BullMQ.
// BullMQ uses ioredis under the hood and needs host/port/password separately.
function parseRedisConnection(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    username: url.username !== 'default' ? url.username : undefined,
    tls: config.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    maxRetriesPerRequest: null, // Required for BullMQ workers
  };
}

export const redisConnection = parseRedisConnection();

// ─── Queue names ──────────────────────────────────────────────────────────────
export const QUEUE_BULK = 'continuum-bulk';
export const QUEUE_MONITOR = 'continuum-monitor';
export const QUEUE_WEBHOOK = 'continuum-webhooks';

// ─── Queue instances ──────────────────────────────────────────────────────────
// Queues are lightweight producers — instantiated in the API server.
// Workers create their own Queue + Worker instances in separate processes.

export const bulkQueue = new Queue<BulkJobPayload>(QUEUE_BULK, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1, // Bulk jobs do not auto-retry — failure is surfaced via BulkJob.status
    removeOnComplete: { count: 500, age: 86400 },
    removeOnFail: { count: 100, age: 604800 },
  },
});

export const monitorQueue = new Queue<MonitorCheckPayload | MonitorRecheckPayload>(QUEUE_MONITOR, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 50, age: 86400 },
  },
});

export const webhookQueue = new Queue<WebhookDeliveryPayload>(QUEUE_WEBHOOK, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1, // Retry logic is manual — each attempt creates a new delayed job
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 500, age: 604800 },
  },
});

/**
 * Gracefully close all queue connections.
 * Call this during server shutdown.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([bulkQueue.close(), monitorQueue.close(), webhookQueue.close()]);
}

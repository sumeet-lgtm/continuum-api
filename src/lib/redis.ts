import IORedis from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

let _client: IORedis | null = null;

/**
 * Raw ioredis client — speaks the Redis protocol directly (Railway Redis,
 * local Redis, or any rediss:// endpoint).
 *
 * Configured to fail fast: rate limiting and locks must fail open on a Redis
 * outage rather than hang API requests waiting on infinite retries.
 */
function getClient(): IORedis {
  if (!_client) {
    _client = new IORedis(config.REDIS_URL, {
      // family 0 = dual-stack DNS lookup — required for Railway private
      // networking (*.railway.internal resolves via IPv6 only)
      family: 0,
      tls: config.REDIS_URL.startsWith('rediss://') ? {} : undefined,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    _client.on('error', (err) => {
      logger.warn({ err: err.message }, 'Redis connection error');
    });
  }
  return _client;
}

interface SetOptions {
  nx?: boolean;
  px?: number;
}

/**
 * Thin wrapper keeping the call signatures the rest of the codebase already
 * uses (previously the @upstash/redis REST client).
 */
export const redis = {
  incr: (key: string): Promise<number> => getClient().incr(key),
  expire: (key: string, seconds: number): Promise<number> => getClient().expire(key, seconds),
  ttl: (key: string): Promise<number> => getClient().ttl(key),
  get: (key: string): Promise<string | null> => getClient().get(key),
  del: (key: string): Promise<number> => getClient().del(key),
  set: (key: string, value: string, opts?: SetOptions): Promise<'OK' | null> => {
    if (opts?.nx && opts?.px !== undefined) {
      return getClient().set(key, value, 'PX', opts.px, 'NX');
    }
    if (opts?.nx) {
      return getClient().set(key, value, 'NX');
    }
    if (opts?.px !== undefined) {
      return getClient().set(key, value, 'PX', opts.px) as Promise<'OK'>;
    }
    return getClient().set(key, value) as Promise<'OK'>;
  },
  ping: (): Promise<string> => getClient().ping(),
};

export function getRedis(): typeof redis {
  return redis;
}

/**
 * Ping Redis to verify connectivity. Returns true if reachable.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (err) {
    logger.error({ err }, 'Redis ping failed');
    return false;
  }
}

// Key namespace helpers — all keys are prefixed to avoid collisions
export const redisKey = {
  rateLimit:    (apiKeyId: string)  => `rl:${apiKeyId}`,
  bulkJobLock:  (jobId: string)     => `lock:bulk:${jobId}`,
  monitorLock:  (monitorId: string) => `lock:monitor:${monitorId}`,
} as const;

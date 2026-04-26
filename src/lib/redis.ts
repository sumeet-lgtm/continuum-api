import { Redis } from '@upstash/redis';
import { config } from '../config.js';
import { logger } from './logger.js';

let _redis: Redis | null = null;

/**
 * Parse an Upstash Redis URL into the { url, token } shape required by @upstash/redis.
 *
 * Upstash provides connection URLs in the form:
 *   rediss://default:<TOKEN>@<HOST>:<PORT>
 *
 * The @upstash/redis REST client requires:
 *   url:   https://<HOST>   (no port — Upstash REST is always port 443)
 *   token: <TOKEN>
 *
 * For local Redis (no auth, plain redis://), we use a noop token and http.
 */
function parseUpstashConfig(redisUrl: string): { url: string; token: string } {
  const parsed = new URL(redisUrl);
  const token = parsed.password ? decodeURIComponent(parsed.password) : 'local';
  const protocol = redisUrl.startsWith('rediss://') ? 'https' : 'http';
  const port = parsed.port && parsed.port !== '443' && parsed.port !== '80'
    ? `:${parsed.port}`
    : '';
  return {
    url: `${protocol}://${parsed.hostname}${port}`,
    token,
  };
}

export function getRedis(): Redis {
  if (!_redis) {
    const { url, token } = parseUpstashConfig(config.REDIS_URL);
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export const redis = getRedis();

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

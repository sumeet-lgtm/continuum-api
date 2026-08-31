import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { redis, redisKey } from '../lib/redis.js';
import { config } from '../config.js';
import { Errors } from './errorHandler.js';
import { logger } from '../lib/logger.js';

interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter using Redis INCR + EXPIRE.
 *
 * Window resets on the minute boundary of the first request in that window.
 * Fails open if Redis is unavailable — Redis outage will not take down the API.
 */
async function checkRateLimit(
  apiKeyId: string,
  limitRpm: number,
): Promise<RateLimitInfo | undefined> {
  const key = redisKey.rateLimit(apiKeyId);

  try {
    const count = await redis.incr(key);

    if (count === 1) {
      // First request in this window — set TTL
      await redis.expire(key, 60);
    }

    if (count > limitRpm) {
      const ttl = await redis.ttl(key);
      const retryAfterMs = ttl > 0 ? ttl * 1000 : 60_000;
      throw Errors.rateLimited(retryAfterMs);
    }

    const remaining = Math.max(0, limitRpm - count);
    const ttl = await redis.ttl(key);
    const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : 60_000);

    return { limit: limitRpm, remaining, resetAt };
  } catch (err) {
    // Re-throw AppErrors (e.g. RATE_LIMITED) — swallow Redis connectivity errors
    if (err instanceof Error && 'statusCode' in err) {
      throw err;
    }
    logger.warn({ err, apiKeyId }, 'Redis rate limit check failed — failing open');
    return undefined;
  }
}

async function checkIpRateLimit(
  scope: string,
  ip: string,
  limitRpm: number,
): Promise<RateLimitInfo | undefined> {
  const key = redisKey.ipRateLimit(scope, ip);

  try {
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    if (count > limitRpm) {
      const ttl = await redis.ttl(key);
      const retryAfterMs = ttl > 0 ? ttl * 1000 : 60_000;
      throw Errors.rateLimited(retryAfterMs);
    }

    const remaining = Math.max(0, limitRpm - count);
    const ttl = await redis.ttl(key);
    const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : 60_000);

    return { limit: limitRpm, remaining, resetAt };
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) {
      throw err;
    }
    logger.warn({ err, scope, ip }, 'Redis IP rate limit check failed — failing open');
    return undefined;
  }
}

/**
 * Rate limiter for routes with no API key to key on — the tracking pixel,
 * click redirect, unsubscribe confirm link, and the SNS bounce/complaint
 * webhook are all reachable by anyone, unauthenticated. requireRateLimit
 * above is a no-op on these (it bails out when request.apiKey is unset),
 * which left them with no volume limit at all.
 *
 * Returns a preHandler bound to a fixed per-minute limit and a scope name
 * so different public routes don't share one IP's budget.
 *
 * Usage:
 *   { preHandler: [requireIpRateLimit('track', 300)] }
 */
export function requireIpRateLimit(scope: string, limitRpm: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const info = await checkIpRateLimit(scope, request.ip, limitRpm);
    if (info) {
      void reply.header('X-RateLimit-Limit', String(info.limit));
      void reply.header('X-RateLimit-Remaining', String(info.remaining));
      void reply.header('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)));
    }
  };
}

async function rateLimitPluginFn(fastify: FastifyInstance): Promise<void> {
  // No global hook — rate limiting is applied per-route via requireRateLimit preHandler
  void fastify;
}

/**
 * Prehandler — must be ordered AFTER requireAuth so request.apiKey is populated.
 *
 * Usage:
 *   { preHandler: [requireAuth, requireRateLimit] }
 */
export async function requireRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.apiKey) return;

  const limitRpm = request.apiKey.rateLimit ?? config.DEFAULT_RATE_LIMIT_RPM;
  const info = await checkRateLimit(request.apiKey.id, limitRpm);

  if (info) {
    void reply.header('X-RateLimit-Limit', String(info.limit));
    void reply.header('X-RateLimit-Remaining', String(info.remaining));
    void reply.header('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)));
  }
}

export const rateLimitPlugin = fp(rateLimitPluginFn, {
  name: 'rate-limit',
  dependencies: ['auth'],
});

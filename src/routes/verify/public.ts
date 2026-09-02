import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyEmail } from '../../engine/index.js';
import { redis, redisKey } from '../../lib/redis.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';

const PUBLIC_DAILY_LIMIT = 5; // free checks per IP per day

const querySchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .min(1)
    .max(254)
    .transform((s) => s.trim().toLowerCase()),
});

export async function verifyPublicRoute(fastify: FastifyInstance): Promise<void> {
  // GET /v1/verify/public?email=... — no API key, IP rate-limited to 5/day
  fastify.get(
    '/verify/public',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { email } = parsed.data;
      const ip = request.ip ?? '0.0.0.0';
      const rateLimitKey = redisKey.ipRateLimit('verify-public', ip);

      // IP rate limit: 5 per day, resets at midnight UTC
      try {
        const count = await redis.incr(rateLimitKey);
        if (count === 1) {
          const secondsUntilMidnight = Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000);
          await redis.expire(rateLimitKey, secondsUntilMidnight);
        }
        if (count > PUBLIC_DAILY_LIMIT) {
          return reply.status(429).send({
            error: 'rate_limited',
            message: `Free checker is limited to ${PUBLIC_DAILY_LIMIT} lookups per day. Sign up for an API key to verify unlimited emails.`,
            signup_url: 'https://app.continuumapi.com/signup',
          });
        }
      } catch (err) {
        logger.warn({ err, ip }, 'Redis rate-limit check failed for public verify — allowing request');
      }

      const result = await verifyEmail({ email, apiKeyId: 'public', bulkJobId: undefined, sourceIp: ip });

      return reply.status(200).send({
        email: result.email,
        domain: result.domain,
        status: result.status,
        subStatus: result.subStatus ?? null,
        score: result.score,
        checks: {
          syntaxValid: result.checks.syntaxValid,
          mxFound: result.checks.mxFound,
          isDisposable: result.checks.isDisposable,
          isRoleAccount: result.checks.isRoleAccount,
          isCatchAll: result.checks.isCatchAll ?? null,
          blacklisted: result.checks.blacklisted ?? false,
        },
        checkedAt: result.checkedAt.toISOString(),
        free_checks_used: true,
        upgrade_url: 'https://app.continuumapi.com/signup',
      });
    },
  );
}

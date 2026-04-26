import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { verifyEmail } from '../../engine/index.js';
import type { VerificationResult } from '../../types/verification.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { Errors } from '../../plugins/errorHandler.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const bodySchema = z.object({
  email: z
    .string({ required_error: 'email is required' })
    .min(1, 'email cannot be empty')
    .max(254, 'email exceeds maximum length of 254 characters')
    .transform((s) => s.trim().toLowerCase()),
});

type VerifyBody = z.infer<typeof bodySchema>;

interface VerifyRoute {
  Body: VerifyBody;
}

// ─── Fastify JSON Schema (for Ajv validation + serialisation speed) ──────────

const responseSchema = {
  type: 'object',
  properties: {
    id:         { type: 'string' },
    email:      { type: 'string' },
    domain:     { type: 'string' },
    status:     { type: 'string', enum: ['valid', 'invalid', 'risky', 'unknown'] },
    subStatus:  { type: ['string', 'null'] },
    checks: {
      type: 'object',
      properties: {
        syntaxValid:   { type: 'boolean' },
        mxFound:       { type: 'boolean' },
        mxRecords:     { type: 'array', items: { type: 'string' } },
        isDisposable:  { type: 'boolean' },
        isRoleAccount: { type: 'boolean' },
        smtpChecked:   { type: 'boolean' },
        smtpReachable: { type: ['boolean', 'null'] },
        isCatchAll:    { type: ['boolean', 'null'] },
        greylisted:    { type: 'boolean' },
      },
    },
    score:      { type: 'integer', minimum: 0, maximum: 100 },
    durationMs: { type: 'integer' },
    checkedAt:  { type: 'string' },
  },
} as const;

// ─── Route ────────────────────────────────────────────────────────────────────

export async function verifySingleRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<VerifyRoute>(
    '/verify',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 1, maxLength: 254 },
          },
        },
        response: { 200: responseSchema },
      },
    },
    async (request: FastifyRequest<VerifyRoute>, reply: FastifyReply) => {
      // Validate and normalise with zod (lowercasing, trimming)
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { email } = parsed.data;

      // ── Run verification engine ─────────────────────────────────────────
      const result = await verifyEmail({
        email,
        apiKeyId:  request.apiKey.id,
        bulkJobId: undefined,
        sourceIp:  request.ip,
      });

      // ── Dispatch verification_complete webhooks (non-blocking) ──────────
      void dispatchVerificationWebhooks(request.apiKey.id, result);

      // ── Respond ─────────────────────────────────────────────────────────
      return reply.status(200).send({
        id:        result.id,
        email:     result.email,
        domain:    result.domain,
        status:    result.status,
        subStatus: result.subStatus,
        checks: {
          syntaxValid:   result.checks.syntaxValid,
          mxFound:       result.checks.mxFound,
          mxRecords:     result.checks.mxRecords,
          isDisposable:  result.checks.isDisposable,
          isRoleAccount: result.checks.isRoleAccount,
          smtpChecked:   result.checks.smtpChecked,
          smtpReachable: result.checks.smtpReachable,
          isCatchAll:    result.checks.isCatchAll,
          greylisted:    result.checks.greylisted,
        },
        score:      result.score,
        durationMs: result.durationMs,
        checkedAt:  result.checkedAt.toISOString(),
      });
    },
  );
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

async function dispatchVerificationWebhooks(
  apiKeyId:  string,
  result:    VerificationResult,
): Promise<void> {
  await dispatchWebhook({
    apiKeyId,
    event:   'verification.completed',
    eventId: buildEventId('verification.completed', result.id),
    payload: {
      event:     'verification.completed',
      id:        result.id,
      email:     result.email,
      domain:    result.domain,
      status:    result.status,
      subStatus: result.subStatus,
      score:     result.score,
      checks: {
        syntaxValid:   result.checks.syntaxValid,
        mxFound:       result.checks.mxFound,
        isDisposable:  result.checks.isDisposable,
        isRoleAccount: result.checks.isRoleAccount,
        smtpChecked:   result.checks.smtpChecked,
        smtpReachable: result.checks.smtpReachable,
        isCatchAll:    result.checks.isCatchAll,
        greylisted:    result.checks.greylisted,
      },
      apiKeyId,
      checkedAt:  result.checkedAt.toISOString(),
      apiVersion: '2',
    },
  });
}

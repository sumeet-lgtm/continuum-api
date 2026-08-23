import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { requireMonthlySendQuota, incrementSendUsageBy } from '../../plugins/usageMeter.js';
import { verifyEmail } from '../../engine/index.js';
import { sendViaSes, isSesConfigured, SesNotConfiguredError } from '../../lib/ses.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import type { EmailSentPayload, EmailSendFailedPayload } from '../../types/webhook.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const bodySchema = z.object({
  to: z.string().email().transform((s) => s.trim().toLowerCase()),
  subject: z.string().min(1).max(500),
  html_body: z.string().optional(),
  text_body: z.string().optional(),
  reply_to: z.string().email().optional(),
  verify_before_send: z.boolean().default(false),
}).refine((v) => v.html_body || v.text_body, {
  message: 'html_body or text_body is required',
});

type SendBody = z.infer<typeof bodySchema>;
interface SendRoute { Body: SendBody }

export async function sendRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<SendRoute>(
    '/send',
    {
      preHandler: [requireAuth, requireRateLimit, requireMonthlySendQuota],
      schema: {
        body: {
          type: 'object',
          required: ['to', 'subject'],
          additionalProperties: false,
          properties: {
            to: { type: 'string', minLength: 1, maxLength: 254 },
            subject: { type: 'string', minLength: 1, maxLength: 500 },
            html_body: { type: 'string' },
            text_body: { type: 'string' },
            reply_to: { type: 'string' },
            verify_before_send: { type: 'boolean' },
          },
        },
      },
    },
    async (request: FastifyRequest<SendRoute>, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }
      const { to, subject, html_body, text_body, reply_to, verify_before_send } = parsed.data;
      const apiKeyId = request.apiKey.id;

      // ── 1. Suppression check (global — see schema.prisma note on Suppression) ──
      const suppressed = await prisma.suppression.findUnique({ where: { email: to } });
      if (suppressed) {
        throw Errors.forbidden(
          `${to} is on the suppression list (${suppressed.reason}) and cannot be sent to.`,
        );
      }

      // ── 2. Verification — inline if requested, otherwise a soft check against
      // recent history. Either way this is the differentiator: refuse to burn a
      // send on an address Continuum already knows is bad. ──────────────────────
      let verificationId: string | null = null;
      if (verify_before_send) {
        const result = await verifyEmail({ email: to, apiKeyId, bulkJobId: undefined, sourceIp: request.ip });
        verificationId = result.id.startsWith('ephemeral_') ? null : result.id;
        if (result.status === 'invalid' || result.checks.isDisposable) {
          throw Errors.forbidden(
            `${to} failed verification (status: ${result.status}${result.checks.isDisposable ? ', disposable' : ''}) — refusing to send.`,
          );
        }
      } else {
        // This lookup is explicitly a soft/best-effort check — a DB hiccup
        // here must not fail the send, or "just warn, don't block" would
        // start blocking on infrastructure errors instead of on anything
        // about the address itself.
        try {
          const recent = await prisma.verification.findFirst({
            where: { email: to, apiKeyId },
            orderBy: { checkedAt: 'desc' },
            select: { id: true, status: true, isDisposable: true },
          });
          if (recent) verificationId = recent.id;
          if (recent && (recent.status === 'invalid' || recent.isDisposable)) {
            logger.warn({ to, apiKeyId, verificationId }, 'Sending to a previously-flagged address (verify_before_send=false, so this only warns)');
          }
        } catch (err) {
          logger.warn({ err, to, apiKeyId }, 'Recent-verification lookup failed — proceeding without it (soft check, fails open)');
        }
      }

      // ── 3. Send via SES ────────────────────────────────────────────────────────
      if (!isSesConfigured()) {
        throw Errors.serviceUnavailable('Send (SES not configured)');
      }

      const from = config.SES_FROM_DOMAIN.includes('@')
        ? config.SES_FROM_DOMAIN
        : `no-reply@${config.SES_FROM_DOMAIN}`;

      let sesMessageId: string | null = null;
      let status: 'sent' | 'failed' = 'sent';
      let errorMessage: string | null = null;

      try {
        const result = await sendViaSes({
          to, from, subject,
          ...(reply_to ? { replyTo: reply_to } : {}),
          ...(html_body ? { htmlBody: html_body } : {}),
          ...(text_body ? { textBody: text_body } : {}),
        });
        sesMessageId = result.sesMessageId;
      } catch (err) {
        status = 'failed';
        errorMessage = err instanceof SesNotConfiguredError
          ? err.message
          : (err instanceof Error ? err.message : 'Unknown SES error');
        logger.error({ err, to, apiKeyId }, 'SES send failed');
      }

      // ── 4. Persist ──────────────────────────────────────────────────────────────
      // If status === 'sent' here, SES has ALREADY accepted the email — a DB
      // failure below must never turn into a 500 that tells the customer the
      // send failed, or they'll retry and double-send something that already
      // went out. Same safety net engine/index.ts's persistAndReturn uses for
      // verification: fall back to a synthetic id and keep responding as if
      // nothing failed, since from the customer's side, nothing did.
      let record: { id: string; createdAt: Date };
      try {
        record = await prisma.sendMessage.create({
          data: {
            apiKeyId, to, from, subject,
            replyTo: reply_to ?? null,
            sesMessageId,
            status,
            errorMessage,
            verificationId,
            sentAt: status === 'sent' ? new Date() : null,
          },
          select: { id: true, createdAt: true },
        });
      } catch (err) {
        logger.error({ err, to, apiKeyId, sesMessageId, status }, 'Failed to persist SendMessage — SES outcome stands regardless');
        record = { id: `ephemeral_${Date.now()}`, createdAt: new Date() };
      }

      // Only a send that actually left the building counts against quota —
      // an SES-side failure is Continuum's infrastructure problem, not the
      // customer's, and shouldn't cost them one of their allotted sends.
      if (status === 'sent') {
        void incrementSendUsageBy(apiKeyId, 1);
      }

      // ── 5. Webhook (non-blocking) ────────────────────────────────────────────────
      if (status === 'sent') {
        const payload: EmailSentPayload = {
          event: 'email.sent',
          id: record.id,
          to, subject,
          sesMessageId,
          apiKeyId,
          sentAt: new Date().toISOString(),
          apiVersion: '2',
        };
        void dispatchWebhook({
          apiKeyId, event: 'email.sent',
          eventId: buildEventId('email.sent', record.id),
          payload,
        });
      } else {
        const payload: EmailSendFailedPayload = {
          event: 'email.send_failed',
          id: record.id, to, errorMessage, apiKeyId, apiVersion: '2',
        };
        void dispatchWebhook({
          apiKeyId, event: 'email.send_failed',
          eventId: buildEventId('email.send_failed', record.id),
          payload,
        });
      }

      if (status === 'failed') {
        return reply.status(502).send({
          id: record.id, status, sesMessageId, errorMessage,
        });
      }
      return reply.status(200).send({ id: record.id, sesMessageId, status });
    },
  );
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { requireMonthlySendQuota, incrementSendUsageBy } from '../../plugins/usageMeter.js';
import { sendViaSes, isSesConfigured, SesNotConfiguredError } from '../../lib/ses.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { generateUnsubToken, generateUnsubHtml } from '../../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../../lib/tracking.js';
import type { EmailSentPayload } from '../../types/webhook.js';

const messageSchema = z.object({
  to: z.string().email().transform(s => s.trim().toLowerCase()),
  subject: z.string().min(1).max(500),
  html_body: z.string().optional(),
  text_body: z.string().optional(),
  reply_to: z.string().email().optional(),
  tags: z.record(z.string()).optional(),
  idempotency_key: z.string().max(200).optional(),
});

const batchSchema = z.object({
  messages: z.array(messageSchema).min(1).max(100),
});

export async function batchSendRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/send/batch',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = batchSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
      }

      const { messages } = parsed.data;
      const apiKeyId = request.apiKey.id;

      if (!isSesConfigured()) throw Errors.serviceUnavailable('Send (SES not configured)');

      // Check combined quota
      await (requireMonthlySendQuota as Function)(request, reply);

      const from = config.SES_FROM_DOMAIN.includes('@')
        ? config.SES_FROM_DOMAIN
        : `no-reply@${config.SES_FROM_DOMAIN}`;

      const results: Array<{ id: string; status: string; error?: string }> = [];
      let successCount = 0;

      for (const msg of messages) {
        const { to, subject, html_body, text_body, reply_to, tags } = msg;

        try {
          // Suppression check
          const suppressed = await prisma.suppression.findUnique({ where: { email: to } });
          if (suppressed) {
            results.push({ id: '', status: 'suppressed', error: `${to} is suppressed (${suppressed.reason})` });
            continue;
          }

          // Idempotency
          if (msg.idempotency_key) {
            const existing = await prisma.sendMessage.findUnique({
              where: { idempotencyKey: msg.idempotency_key },
              select: { id: true, status: true },
            });
            if (existing) {
              results.push({ id: existing.id, status: existing.status });
              continue;
            }
          }

          const unsubToken = generateUnsubToken(to, apiKeyId);
          const listUnsubscribeHeader = `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`;

          // Pre-create DB record to get real ID for tracking tokens
          const record = await prisma.sendMessage.create({
            data: {
              apiKeyId, to, from, subject,
              replyTo: reply_to ?? null, sesMessageId: null, status: 'queued',
              tags: tags ?? {}, idempotencyKey: msg.idempotency_key ?? null,
              trackingToken: 'pending',
            },
            select: { id: true },
          });

          let htmlBody = html_body;
          if (htmlBody) {
            htmlBody = htmlBody.replace(/<\/body>/i, `${generateUnsubHtml(unsubToken)}</body>`);
            htmlBody = injectTracking(htmlBody, generateOpenToken(record.id), (url) => generateClickToken(record.id, url));
          }

          const { sesMessageId } = await sendViaSes({
            to, from, subject,
            ...(reply_to ? { replyTo: reply_to } : {}),
            ...(htmlBody !== undefined ? { htmlBody } : {}),
            ...(text_body ? { textBody: text_body } : {}),
            listUnsubscribeHeader,
          });

          await prisma.sendMessage.update({
            where: { id: record.id },
            data: { sesMessageId, status: 'sent', sentAt: new Date(), trackingToken: record.id },
          });

          successCount++;
          results.push({ id: record.id, status: 'sent' });

          const payload: EmailSentPayload = {
            event: 'email.sent', id: record.id, to, subject, sesMessageId, apiKeyId,
            sentAt: new Date().toISOString(), apiVersion: '2',
          };
          void dispatchWebhook({ apiKeyId, event: 'email.sent', eventId: buildEventId('email.sent', record.id), payload });

        } catch (err) {
          const message = err instanceof SesNotConfiguredError ? err.message : (err instanceof Error ? err.message : 'Unknown error');
          logger.error({ err, to, apiKeyId }, 'Batch send item failed');
          // Attempt to mark pre-created record as failed (best-effort)
          results.push({ id: '', status: 'failed', error: message });
        }
      }

      if (successCount > 0) {
        void incrementSendUsageBy(apiKeyId, successCount);
      }

      return reply.status(200).send({ results, sent: successCount, total: messages.length });
    },
  );
}

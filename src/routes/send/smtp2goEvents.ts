import type { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../config.js';
import type {
  EmailDeliveredPayload, EmailBouncedPayload, EmailComplainedPayload,
} from '../../types/webhook.js';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';
import {
  suppress, trackSoftBounce, correctOnGroundTruth, checkComplaintRate,
} from '../../lib/bounceHandling.js';

// ─── SMTP2GO event shape ────────────────────────────────────────────────────
//
// Field names confirmed against the live "Email Webhook Parameters" table at
// developers.smtp2go.com/docs/webhooks-overview — not guessed. SMTP2GO has no
// HMAC-signed webhook the way SNS does (confirmed: their docs only offer
// URL-based auth — a username/password in the URL, or IP allowlisting), so
// this route is protected by a random path-segment token instead
// (SMTP2GO_WEBHOOK_TOKEN) rather than a cryptographic signature.

interface Smtp2goEvent {
  event?: 'processed' | 'delivered' | 'open' | 'click' | 'bounce' | 'spam' | 'unsubscribe' | 'resubscribe' | 'reject';
  rcpt?: string;
  email_id?: string;
  bounce?: 'hard' | 'soft';
  message?: string;
}

/**
 * POST /v1/send/smtp2go-events/:token — SMTP2GO calls this, not a customer.
 * requireAuth doesn't apply (no API key on an inbound webhook); the path
 * token is the only auth SMTP2GO's webhook design offers.
 */
export async function smtp2goEventsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { token: string } }>(
    '/send/smtp2go-events/:token',
    { preHandler: [requireIpRateLimit('smtp2go-events', 600)] },
    async (request, reply: FastifyReply) => {
      if (!config.SMTP2GO_WEBHOOK_TOKEN || request.params.token !== config.SMTP2GO_WEBHOOK_TOKEN) {
        logger.warn('SMTP2GO webhook called with invalid/missing token — rejecting');
        return reply.status(401).send({ error: 'Invalid token' });
      }

      // "JSON or Form encoded... depending on the output defined in the
      // webhook's settings" per SMTP2GO's own docs — accept either rather
      // than assuming JSON was configured.
      const body = request.body as Smtp2goEvent | Record<string, string>;
      const event = normalizeEvent(body);

      const emailId = event.email_id;
      const eventType = event.event;
      if (!emailId || !eventType) {
        logger.warn({ eventType, emailId }, 'SMTP2GO event missing email_id or event type — ignoring');
        return reply.status(200).send({ received: true });
      }

      // Reverse lookup keyed by smtp2goMessageId, which is globally @unique
      // on SendMessage (schema.prisma) — apiKeyId isn't known yet at this
      // point, this lookup is how it gets resolved, and uniqueness
      // guarantees no cross-tenant ambiguity.
      // tenant-sweep: see comment above
      const sendMessage = await prisma.sendMessage.findFirst({ where: { smtp2goMessageId: emailId } });
      if (!sendMessage) {
        // Not one of ours (or arrived before the row committed) — ack, don't retry forever.
        logger.info({ emailId, eventType }, 'SMTP2GO event for unknown sendMessage — acking');
        return reply.status(200).send({ received: true });
      }

      await handleSmtp2goEvent(sendMessage.id, sendMessage.apiKeyId, event);

      return reply.status(200).send({ received: true });
    },
  );
}

// SMTP2GO's form-encoded webhook option flattens everything to strings —
// bounce/event fields survive that fine as-is, so no coercion beyond the
// type assertion at the call site is needed for the fields this route reads.
function normalizeEvent(body: Smtp2goEvent | Record<string, string>): Smtp2goEvent {
  return body as Smtp2goEvent;
}

async function handleSmtp2goEvent(
  sendMessageId: string,
  apiKeyId: string,
  event: Smtp2goEvent,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const email = event.rcpt;

  if (event.event === 'bounce') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'bounced', rawPayload: event as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'bounced' } });

    if (email) {
      if (event.bounce === 'hard') {
        await suppress(email, 'hard_bounce', apiKeyId);
        void correctOnGroundTruth(email, apiKeyId);
      } else if (event.bounce === 'soft') {
        await trackSoftBounce(email, apiKeyId);
      }
      const payload: EmailBouncedPayload = {
        event: 'email.bounced', id: sendMessageId, to: email,
        bounceType: event.bounce === 'hard' ? 'Permanent' : event.bounce === 'soft' ? 'Transient' : null,
        apiKeyId, occurredAt, apiVersion: '2',
      };
      void dispatchWebhook({
        apiKeyId, event: 'email.bounced',
        eventId: buildEventId('email.bounced', sendMessageId), payload,
      });
    }
    return;
  }

  if (event.event === 'spam') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'complained', rawPayload: event as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'complained' } });

    if (email) {
      await suppress(email, 'complaint', apiKeyId);
      const payload: EmailComplainedPayload = {
        event: 'email.complained', id: sendMessageId, to: email, apiKeyId, occurredAt, apiVersion: '2',
      };
      void dispatchWebhook({
        apiKeyId, event: 'email.complained',
        eventId: buildEventId('email.complained', sendMessageId), payload,
      });
    }
    void checkComplaintRate(apiKeyId);
    return;
  }

  if (event.event === 'delivered') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'delivered', rawPayload: event as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'delivered' } });

    if (email) {
      const payload: EmailDeliveredPayload = {
        event: 'email.delivered', id: sendMessageId, to: email, apiKeyId, occurredAt, apiVersion: '2',
      };
      void dispatchWebhook({
        apiKeyId, event: 'email.delivered',
        eventId: buildEventId('email.delivered', sendMessageId), payload,
      });
    }
    return;
  }

  logger.info({ eventType: event.event, sendMessageId }, 'Unhandled SMTP2GO event type — recorded nowhere, no webhook');
}

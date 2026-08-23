import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { verifySnsMessage, type SnsMessage } from '../../lib/snsVerify.js';
import { logger } from '../../lib/logger.js';
import type {
  EmailDeliveredPayload, EmailBouncedPayload, EmailComplainedPayload,
} from '../../types/webhook.js';

// ─── SES event shapes (only the fields read) ─────────────────────────────────

interface SesEvent {
  eventType?: string;
  notificationType?: string; // older raw-notification field name
  mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }> };
  complaint?: { complainedRecipients?: Array<{ emailAddress?: string }> };
  delivery?: { recipients?: string[] };
}

/**
 * POST /v1/send/events — Amazon SNS calls this, not a customer.
 * No requireAuth: the SNS message signature IS the authentication.
 */
export async function sendEventsRoute(fastify: FastifyInstance): Promise<void> {
  // SNS posts JSON with Content-Type: text/plain — parse it as raw text,
  // same "manual parse inside this plugin's scope" pattern billing/index.ts
  // uses for Dodo's webhook, where the raw bytes matter for signing/parsing.
  fastify.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  fastify.post(
    '/send/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let msg: SnsMessage;
      try {
        const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        msg = JSON.parse(raw) as SnsMessage;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }

      const verified = await verifySnsMessage(msg);
      if (!verified) {
        logger.warn({ type: msg.Type, messageId: msg.MessageId }, 'SNS signature verification failed — rejecting');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // ── Subscription handshake — happens once per topic subscription ─────────
      if (msg.Type === 'SubscriptionConfirmation') {
        if (msg.SubscribeURL) {
          try {
            await fetch(msg.SubscribeURL, { signal: AbortSignal.timeout(10_000) });
            logger.info({ topicArn: msg.TopicArn }, 'SNS subscription confirmed');
          } catch (err) {
            logger.error({ err, topicArn: msg.TopicArn }, 'Failed to confirm SNS subscription');
          }
        }
        return reply.status(200).send({ received: true });
      }

      if (msg.Type === 'UnsubscribeConfirmation') {
        logger.info({ topicArn: msg.TopicArn }, 'SNS unsubscribe confirmation received');
        return reply.status(200).send({ received: true });
      }

      if (msg.Type !== 'Notification') {
        logger.warn({ type: msg.Type }, 'Unrecognized SNS message type — ignoring');
        return reply.status(200).send({ received: true });
      }

      // ── Notification — the actual SES event ───────────────────────────────────
      let sesEvent: SesEvent;
      try {
        sesEvent = JSON.parse(msg.Message) as SesEvent;
      } catch {
        logger.warn({ messageId: msg.MessageId }, 'SNS Notification.Message was not valid JSON');
        return reply.status(200).send({ received: true }); // ack — retrying won't fix malformed content
      }

      const sesMessageId = sesEvent.mail?.messageId;
      const eventType = sesEvent.eventType ?? sesEvent.notificationType;
      if (!sesMessageId || !eventType) {
        logger.warn({ eventType, sesMessageId }, 'SES event missing messageId or eventType — ignoring');
        return reply.status(200).send({ received: true });
      }

      const sendMessage = await prisma.sendMessage.findUnique({ where: { sesMessageId } });
      if (!sendMessage) {
        // Not one of ours (or arrived before the row committed) — ack, don't retry forever.
        logger.info({ sesMessageId, eventType }, 'SES event for unknown sendMessage — acking');
        return reply.status(200).send({ received: true });
      }

      await handleSesEvent(sendMessage.id, sendMessage.apiKeyId, eventType, sesEvent);

      return reply.status(200).send({ received: true });
    },
  );
}

async function handleSesEvent(
  sendMessageId: string,
  apiKeyId: string,
  eventType: string,
  sesEvent: SesEvent,
): Promise<void> {
  const occurredAt = new Date().toISOString();

  if (eventType === 'Bounce') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'bounced', rawPayload: sesEvent as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'bounced' } });

    const bounceType = sesEvent.bounce?.bounceType ?? null;
    const recipients = sesEvent.bounce?.bouncedRecipients?.map((r) => r.emailAddress).filter((e): e is string => Boolean(e)) ?? [];

    for (const email of recipients) {
      if (bounceType === 'Permanent') {
        await suppress(email, 'hard_bounce', apiKeyId);
      }
      const payload: EmailBouncedPayload = {
        event: 'email.bounced', id: sendMessageId, to: email, bounceType, apiKeyId, occurredAt, apiVersion: '2',
      };
      void dispatchWebhook({
        apiKeyId, event: 'email.bounced',
        eventId: buildEventId('email.bounced', sendMessageId), payload,
      });
    }
    return;
  }

  if (eventType === 'Complaint') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'complained', rawPayload: sesEvent as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'complained' } });

    const recipients = sesEvent.complaint?.complainedRecipients?.map((r) => r.emailAddress).filter((e): e is string => Boolean(e)) ?? [];
    for (const email of recipients) {
      await suppress(email, 'complaint', apiKeyId);
      const payload: EmailComplainedPayload = {
        event: 'email.complained', id: sendMessageId, to: email, apiKeyId, occurredAt, apiVersion: '2',
      };
      void dispatchWebhook({
        apiKeyId, event: 'email.complained',
        eventId: buildEventId('email.complained', sendMessageId), payload,
      });
    }
    return;
  }

  if (eventType === 'Delivery') {
    await prisma.sendEvent.create({
      data: { sendMessageId, type: 'delivered', rawPayload: sesEvent as object },
    });
    await prisma.sendMessage.update({ where: { id: sendMessageId }, data: { status: 'delivered' } });

    const recipients = sesEvent.delivery?.recipients ?? [];
    for (const email of recipients) {
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

  logger.info({ eventType, sendMessageId }, 'Unhandled SES event type — recorded nowhere, no webhook');
}

/** Upsert-by-email: the unique constraint on Suppression.email makes a repeat bounce a no-op. */
async function suppress(email: string, reason: 'hard_bounce' | 'complaint', apiKeyId: string): Promise<void> {
  await prisma.suppression.upsert({
    where: { email },
    update: {}, // first reason wins; don't overwrite an existing suppression's cause
    create: { email, reason, apiKeyId },
  }).catch((err) => {
    logger.error({ err, email, reason }, 'Failed to write suppression');
  });
}

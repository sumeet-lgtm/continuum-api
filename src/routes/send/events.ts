import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { verifySnsMessage, type SnsMessage } from '../../lib/snsVerify.js';
import { invalidateSmtpCache } from '../../engine/smtpCache.js';
import { monitorQueue } from '../../lib/queue.js';
import { logger } from '../../lib/logger.js';
import type {
  EmailDeliveredPayload, EmailBouncedPayload, EmailComplainedPayload,
} from '../../types/webhook.js';
import type { MonitorRecheckPayload } from '../../types/job.js';

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
        void correctOnGroundTruth(email, apiKeyId);
      } else if (bounceType === 'Transient') {
        await trackSoftBounce(email, apiKeyId);
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

/**
 * Closed-loop verification correction: a real SES hard bounce is stronger
 * ground truth than any point-in-time SMTP probe (ours or a provider's) —
 * the message was actually attempted and actually rejected. No standalone
 * verifier (ZeroBounce, NeverBounce, MillionVerifier) ever sees this signal,
 * because they don't also send; a "valid" verdict from them just goes stale
 * silently. Here, a hard bounce immediately:
 *   1. drops the cached SMTP verdict for this address so the next check
 *      re-probes instead of trusting a now-contradicted cache entry, and
 *   2. force-rechecks any active Monitor watching this address right now,
 *      instead of waiting for its next scheduled interval — the fastest
 *      possible drift alert is "we just watched it bounce for real."
 */
async function correctOnGroundTruth(email: string, apiKeyId: string): Promise<void> {
  const lower = email.toLowerCase();
  await invalidateSmtpCache(lower);

  try {
    const monitor = await prisma.monitor.findFirst({
      where: { email: lower, apiKeyId, isActive: true, pausedAt: null },
      select: { id: true },
    });
    if (!monitor) return;

    await prisma.monitor.update({ where: { id: monitor.id }, data: { nextCheckAt: new Date() } });
    await monitorQueue.add(
      'recheck-single',
      { monitorId: monitor.id, source: 'bounce_ground_truth' } satisfies MonitorRecheckPayload,
      { jobId: `recheck-${monitor.id}-${Date.now()}`, priority: 1 },
    );
    logger.info({ email: lower, monitorId: monitor.id }, 'Hard bounce triggered immediate monitor recheck');
  } catch (err) {
    logger.warn({ err, email: lower }, 'Ground-truth monitor recheck failed — non-fatal');
  }
}

/** Upsert-by-email: the unique constraint on Suppression.email makes a repeat bounce a no-op. */
async function suppress(email: string, reason: 'hard_bounce' | 'complaint' | 'soft_bounce', apiKeyId: string): Promise<void> {
  await prisma.suppression.upsert({
    where: { email },
    update: {}, // first reason wins; don't overwrite an existing suppression's cause
    create: { email, reason, apiKeyId },
  }).catch((err) => {
    logger.error({ err, email, reason }, 'Failed to write suppression');
  });
}

/** 3-strike soft bounce suppression: track transient bounces, suppress after 3 consecutive. */
async function trackSoftBounce(email: string, apiKeyId: string): Promise<void> {
  try {
    // Check if already hard-suppressed — skip if so
    const existing = await prisma.suppression.findUnique({ where: { email } });
    if (existing) return;

    const track = await prisma.softBounceTrack.upsert({
      where: { email },
      create: { email, apiKeyId: apiKeyId ?? null, bounceCount: 1, lastBounceAt: new Date() },
      update: { bounceCount: { increment: 1 }, lastBounceAt: new Date() },
    });

    logger.info({ email, bounceCount: track.bounceCount }, 'Soft bounce tracked');

    if (track.bounceCount >= 3) {
      await suppress(email, 'soft_bounce', apiKeyId);
      logger.info({ email }, 'Soft bounce threshold reached — email suppressed');
    }
  } catch (err) {
    logger.error({ err, email }, 'Failed to track soft bounce');
  }
}

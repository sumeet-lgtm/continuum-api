import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { verifySnsMessage, type SnsMessage } from '../../lib/snsVerify.js';
import { invalidateSmtpCache } from '../../engine/smtpCache.js';
import { monitorQueue } from '../../lib/queue.js';
import { logger } from '../../lib/logger.js';
import { sendEmail } from '../../lib/email.js';
import { config } from '../../config.js';
import type {
  EmailDeliveredPayload, EmailBouncedPayload, EmailComplainedPayload,
} from '../../types/webhook.js';
import type { MonitorRecheckPayload } from '../../types/job.js';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';

// ─── Bounce rate alert thresholds ─────────────────────────────────────────────

const BOUNCE_WARN_PCT         = 2.0;
const BOUNCE_DANGER_PCT       = 5.0;
const COMPLAINT_WARN_PCT      = 0.08;  // Gmail/Yahoo threshold is 0.1%; warn just below
const COMPLAINT_DANGER_PCT    = 0.3;   // above this = likely blocklisted
const BOUNCE_WINDOW_MS        = 24 * 60 * 60 * 1000;
const BOUNCE_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const BOUNCE_MIN_SENT         = 50;

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
    // IP-scoped, not key-scoped — there's no API key on an SNS callback.
    // Each request (valid or not) makes verifySnsMessage fetch and cache a
    // signing cert over HTTPS before the signature check runs, so this
    // bounds how many of those expensive lookups one source can trigger
    // per minute, independent of whether the signature ultimately passes.
    { preHandler: [requireIpRateLimit('sns-events', 600)] },
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
    void checkComplaintRate(apiKeyId);
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
async function checkBounceRate(apiKeyId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - BOUNCE_WINDOW_MS);
    const [sent, bounced] = await Promise.all([
      prisma.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since } } }),
      prisma.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since }, status: 'bounced' } }),
    ]);

    if (sent < BOUNCE_MIN_SENT) return;

    const pct = (bounced / sent) * 100;
    const level = pct >= BOUNCE_DANGER_PCT ? 'critical' : pct >= BOUNCE_WARN_PCT ? 'warning' : null;
    if (!level) return;

    const cooldownSince = new Date(Date.now() - BOUNCE_ALERT_COOLDOWN_MS);
    const recentAlert = await prisma.auditLog.findFirst({
      where: { action: `bounce_rate.${level}`, actorId: apiKeyId, createdAt: { gte: cooldownSince } },
      select: { id: true },
    });
    if (recentAlert) return;

    const apiKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { ownerId: true, userId: true, label: true, name: true },
    });
    if (!apiKey) return;

    const userId = apiKey.ownerId ?? apiKey.userId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    const keyLabel = apiKey.label ?? apiKey.name ?? apiKeyId.slice(0, 8);
    const subject  = level === 'critical'
      ? `Action required: bounce rate at ${pct.toFixed(1)}% on your account`
      : `Heads up: bounce rate reaching ${pct.toFixed(1)}% — action recommended`;

    await sendEmail({
      to: user.email,
      subject,
      html: `
        <p>Hi,</p>
        <p>Your Continuum account has a ${level === 'critical' ? '<strong>high</strong>' : 'elevated'} email bounce rate over the last 24 hours:</p>
        <ul>
          <li><strong>API key:</strong> ${keyLabel}</li>
          <li><strong>Sent (last 24h):</strong> ${sent.toLocaleString()}</li>
          <li><strong>Bounced:</strong> ${bounced.toLocaleString()}</li>
          <li><strong>Bounce rate:</strong> ${pct.toFixed(1)}%</li>
        </ul>
        ${level === 'critical'
          ? '<p><strong>⚠️ Gmail, Yahoo, and Outlook block senders above 5% bounce rate.</strong> If this continues, your sending reputation may be impacted immediately.</p>'
          : '<p>ISPs typically begin throttling at 2% and blocking at 5%. Taking action now prevents deliverability issues.</p>'}
        <p><strong>Recommended actions:</strong></p>
        <ul>
          <li>Review and clean your recipient lists — remove unengaged addresses.</li>
          <li>Verify your suppression list includes all previously bounced addresses.</li>
          <li>Use Continuum's email verification API before sending to new lists.</li>
        </ul>
        <p>View your <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/analytics">analytics</a> and <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/suppressions">suppression list</a> in your dashboard.</p>
      `,
    });

    await prisma.auditLog.create({
      data: {
        action:     `bounce_rate.${level}`,
        actorId:    apiKeyId,
        actorEmail: keyLabel,
        targets:    [{ type: 'api_key', id: apiKeyId, name: keyLabel }],
      },
    }).catch(() => {});

    logger.info({ apiKeyId, pct: pct.toFixed(1), level, sent, bounced }, 'Bounce rate alert sent');
  } catch (err) {
    logger.warn({ err, apiKeyId }, 'Bounce rate check failed — non-fatal');
  }
}

async function checkComplaintRate(apiKeyId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - BOUNCE_WINDOW_MS);
    const [sent, complained] = await Promise.all([
      prisma.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since } } }),
      prisma.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since }, status: 'complained' } }),
    ]);

    if (sent < BOUNCE_MIN_SENT) return;

    const pct = (complained / sent) * 100;
    const level = pct >= COMPLAINT_DANGER_PCT ? 'critical' : pct >= COMPLAINT_WARN_PCT ? 'warning' : null;
    if (!level) return;

    const cooldownSince = new Date(Date.now() - BOUNCE_ALERT_COOLDOWN_MS);
    const recentAlert = await prisma.auditLog.findFirst({
      where: { action: `complaint_rate.${level}`, actorId: apiKeyId, createdAt: { gte: cooldownSince } },
      select: { id: true },
    });
    if (recentAlert) return;

    const apiKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { ownerId: true, userId: true, label: true, name: true },
    });
    if (!apiKey) return;

    const userId = apiKey.ownerId ?? apiKey.userId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    const keyLabel = apiKey.label ?? apiKey.name ?? apiKeyId.slice(0, 8);
    const subject  = level === 'critical'
      ? `Urgent: spam complaint rate at ${pct.toFixed(2)}% — immediate action required`
      : `Warning: spam complaint rate at ${pct.toFixed(2)}% on your account`;

    await sendEmail({
      to: user.email,
      subject,
      html: `
        <p>Hi,</p>
        <p>Your Continuum account has a ${level === 'critical' ? '<strong>critical</strong>' : 'elevated'} spam complaint rate over the last 24 hours:</p>
        <ul>
          <li><strong>API key:</strong> ${keyLabel}</li>
          <li><strong>Sent (last 24h):</strong> ${sent.toLocaleString()}</li>
          <li><strong>Complained:</strong> ${complained.toLocaleString()}</li>
          <li><strong>Complaint rate:</strong> ${pct.toFixed(2)}%</li>
        </ul>
        ${level === 'critical'
          ? '<p><strong>🚨 Gmail and Yahoo actively block senders above 0.3% complaint rate.</strong> You may already be in their blocklist.</p>'
          : '<p>Gmail and Yahoo start filtering at 0.1% complaint rate. You are approaching that threshold.</p>'}
        <p><strong>Immediate actions recommended:</strong></p>
        <ul>
          <li>Ensure every email has a clear, one-click unsubscribe link.</li>
          <li>Remove anyone who hasn't engaged in the last 90 days.</li>
          <li>Never send to purchased or scraped lists.</li>
          <li>Check the <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/suppressions">suppression list</a> to ensure complainers are not re-contacted.</li>
        </ul>
      `,
    });

    await prisma.auditLog.create({
      data: {
        action:     `complaint_rate.${level}`,
        actorId:    apiKeyId,
        actorEmail: keyLabel,
        targets:    [{ type: 'api_key', id: apiKeyId, name: keyLabel }],
      },
    }).catch(() => {});

    logger.info({ apiKeyId, pct: pct.toFixed(2), level, sent, complained }, 'Complaint rate alert sent');
  } catch (err) {
    logger.warn({ err, apiKeyId }, 'Complaint rate check failed — non-fatal');
  }
}

async function correctOnGroundTruth(email: string, apiKeyId: string): Promise<void> {
  void checkBounceRate(apiKeyId);
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

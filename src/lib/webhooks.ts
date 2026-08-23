/**
 * Canonical webhook dispatch helper.
 *
 * All verification/monitoring/bulk trigger sites call dispatchWebhook()
 * instead of hand-rolling their own fan-out logic.  This ensures:
 *   - Consistent event filtering (only webhooks subscribed to the event)
 *   - Idempotent delivery records via eventId
 *   - Uniform error handling (dispatch failures never propagate to callers)
 *   - Single place to change fan-out behaviour
 *
 * Usage:
 *   await dispatchWebhook({
 *     apiKeyId: 'key-abc',
 *     event:    'verification.completed',
 *     eventId:  `verification.completed:${verificationId}`,
 *     payload:  { event: 'verification.completed', ... },
 *   });
 */

import { prisma }       from './prisma.js';
import { webhookQueue } from './queue.js';
import { config }       from '../config.js';
import { logger }       from './logger.js';
import type { DispatchInput, WebhookEvent } from '../types/webhook.js';

// Mapping from Phase 5 canonical names → legacy Prisma enum values that may
// exist in the database's `events` array column.
const EVENT_ALIASES: Record<string, string[]> = {
  'verification.completed': ['verification.completed', 'verification_complete'],
  'email.status_changed':   ['email.status_changed',   'monitor_status_change'],
  'bulk_job.completed':     ['bulk_job.completed',     'bulk_job_complete'],
  // Legacy names map only to themselves
  'verification_complete':  ['verification_complete',  'verification.completed'],
  'bulk_job_complete':      ['bulk_job_complete',      'bulk_job.completed'],
  'monitor_status_change':  ['monitor_status_change',  'email.status_changed'],
  // Phase 6 (Send) — no legacy underscore alias, these are new in v2
  'email.sent':        ['email.sent'],
  'email.delivered':   ['email.delivered'],
  'email.bounced':     ['email.bounced'],
  'email.complained':  ['email.complained'],
  'email.send_failed': ['email.send_failed'],
};

/**
 * Fan-out a webhook event to all subscribed, active endpoints.
 *
 * - Looks up webhooks for the apiKeyId that subscribe to the event
 *   (checking both canonical and legacy event names)
 * - Creates a WebhookDelivery record per webhook (with idempotency eventId)
 * - Enqueues a BullMQ job per delivery
 * - Never throws — all errors are logged
 */
export async function dispatchWebhook(input: DispatchInput): Promise<void> {
  const { apiKeyId, event, eventId, payload } = input;

  try {
    // Find all active webhooks for this key that subscribe to this event.
    // Because Postgres arrays don't support OR-in-array in Prisma natively,
    // we fetch all active webhooks and filter in JS (reasonable for ≤10 webhooks/key).
    const webhooks = await prisma.webhook.findMany({
      where:  { apiKeyId, isActive: true },
      select: { id: true, url: true, secret: true, events: true },
    });

    const aliases = EVENT_ALIASES[event] ?? [event];
    const subscribed = webhooks.filter((wh: { id: string; url: string; secret: string; events: string[] }) =>
      wh.events.some((e: string) => aliases.includes(e)),
    );

    if (subscribed.length === 0) return;

    await Promise.allSettled(
      subscribed.map((wh: { id: string; url: string; secret: string; events: string[] }) =>
        deliverToEndpoint(wh, event, eventId, payload, apiKeyId),
      ),
    );
  } catch (err) {
    logger.error({ err, apiKeyId, event, eventId }, 'dispatchWebhook: unexpected error');
  }
}


// Map Phase 5 dot-style event names to their Prisma enum values.
// Prisma enums cannot contain dots, so the DB always stores the legacy underscore form.
const PRISMA_EVENT_MAP: Record<string, string> = {
  'verification.completed': 'verification_complete',
  'email.status_changed':   'monitor_status_change',
  'bulk_job.completed':     'bulk_job_complete',
  'email.sent':             'email_sent',
  'email.delivered':        'email_delivered',
  'email.bounced':          'email_bounced',
  'email.complained':       'email_complained',
  'email.send_failed':      'email_send_failed',
};

async function deliverToEndpoint(
  wh:       { id: string; url: string; secret: string },
  event:    WebhookEvent,
  eventId:  string,
  payload:  DispatchInput['payload'],
  apiKeyId: string,
): Promise<void> {
  try {
    // Skip if a delivery record already exists for this eventId+webhookId
    // (prevents duplicate deliveries on double-dispatch bugs)
    if (eventId) {
      const existing = await prisma.webhookDelivery.findFirst({
        where:  { webhookId: wh.id, eventId },
        select: { id: true },
      });
      if (existing) {
        logger.debug(
          { webhookId: wh.id, eventId },
          'Duplicate eventId — skipping delivery creation',
        );
        return;
      }
    }

    const prismaEvent = (PRISMA_EVENT_MAP[event] ?? event) as never;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId:   wh.id,
        event:       prismaEvent,
        eventId:     eventId || null,
        payload:     payload as never,
        maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
      },
      select: { id: true },
    });

    await webhookQueue.add(
      'deliver-webhook',
      {
        deliveryId:    delivery.id,
        webhookId:     wh.id,
        webhookUrl:    wh.url,
        webhookSecret: wh.secret,
        event,
        eventId,
        payload,
        attemptNumber: 1,
      },
      {
        jobId:    `webhook-${delivery.id}-1`,
        priority: 2,
      },
    );

    logger.debug(
      { deliveryId: delivery.id, webhookId: wh.id, event, eventId },
      'Webhook delivery enqueued',
    );
  } catch (err) {
    logger.error(
      { err, webhookId: wh.id, event, eventId, apiKeyId },
      'Failed to create webhook delivery',
    );
  }
}

/**
 * Build a canonical eventId for idempotency.
 * Format: "<event>:<sourceId>"
 */
export function buildEventId(event: WebhookEvent, sourceId: string): string {
  return `${event}:${sourceId}`;
}

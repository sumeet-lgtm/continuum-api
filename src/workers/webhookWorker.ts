/**
 * Webhook Worker — Phase 5
 *
 * Consumes jobs from the `continuum:webhooks` queue.
 * Each BullMQ job = one delivery attempt for one WebhookDelivery record.
 *
 * Per attempt:
 *   1. Load delivery record — skip if already delivered (idempotency guard)
 *   2. Serialize payload to stable JSON
 *   3. Compute X-Continuum-Signature: sha256=HMAC-SHA256(secret, body)
 *   4. POST to the webhook URL with a timeout AbortController
 *   5. Write a WebhookAttempt log row for this HTTP round-trip
 *   6a. On 2xx → mark delivered, update webhook stats
 *   6b. On failure → classify error, increment attempts, schedule retry with jitter
 *   6c. On exhaustion → mark failedPermanently, update webhook stats
 *
 * Retry schedule (exponential backoff + ±20% jitter):
 *   Attempt 1 → ~30s
 *   Attempt 2 → ~2m
 *   Attempt 3 → ~8m
 *   Attempt 4 → ~34m
 *   Attempt 5 → ~2h (capped)
 *
 * Error types:
 *   timeout            — AbortController fired before response
 *   connection_refused — TCP refused (ECONNREFUSED)
 *   network_error      — Other network-layer failure
 *   http_error         — Server responded with non-2xx
 *
 * Concurrency: 5 deliveries in parallel per worker process.
 */

import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { redisConnection, QUEUE_WEBHOOK, webhookQueue } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { hmacSign as signWebhookPayload } from '../lib/crypto.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { initSentry, installCrashReporting } from '../lib/sentry.js';
import { sendEmail } from '../lib/email.js';
import type { WebhookDeliveryPayload } from '../types/webhook.js';

const FAILURE_ALERT_THRESHOLD = 5;      // consecutive permanent failures before alerting
const FAILURE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 h between repeated alerts

async function sendWebhookFailureAlert(webhookId: string, webhookUrl: string, apiKeyId: string, consecutiveFailures: number): Promise<void> {
  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { ownerId: true, userId: true, label: true, name: true },
    });
    if (!apiKey) return;

    const userId = apiKey.ownerId ?? apiKey.userId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    await sendEmail({
      to: user.email,
      subject: `Webhook endpoint failing — ${consecutiveFailures} consecutive failures`,
      html: `
        <p>Hi,</p>
        <p>Your webhook endpoint has failed to deliver ${consecutiveFailures} events in a row:</p>
        <p><strong>Endpoint:</strong> <code>${webhookUrl}</code></p>
        <p>Each failed delivery is automatically retried with exponential backoff, but if the endpoint remains unreachable, deliveries will eventually be marked as permanently failed.</p>
        <p><strong>Next steps:</strong></p>
        <ul>
          <li>Check that <code>${webhookUrl}</code> is reachable and returning a 2xx status.</li>
          <li>View recent delivery attempts in your <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/webhooks">Webhooks dashboard</a>.</li>
          <li>You can manually retry failed deliveries from the dashboard.</li>
        </ul>
        <p>This alert will not repeat for 24 hours unless the endpoint recovers and fails again.</p>
      `,
    });

    await prisma.webhook.update({
      where: { id: webhookId },
      data: { failureAlertSentAt: new Date() },
    });

    logger.info({ webhookId, webhookUrl, consecutiveFailures }, 'Webhook failure alert sent');
  } catch (err) {
    logger.warn({ err, webhookId }, 'Failed to send webhook failure alert (non-fatal)');
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  initSentry('worker-webhook');
  installCrashReporting('worker-webhook');
}

// ─── Retry configuration ──────────────────────────────────────────────────────

export const RETRY_DELAYS_MS: Record<number, number> = {
  1: 30_000,      //  30 seconds
  2: 120_000,     //   2 minutes
  3: 480_000,     //   8 minutes
  4: 2_040_000,   //  34 minutes
  5: 7_200_000,   //   2 hours
};

export const MAX_BACKOFF_MS  = 7_200_000; // 2 hours hard cap
export const RETRY_JITTER    = 0.20;      // ±20% jitter on every retry delay

export function retryDelayMs(attemptNumber: number): number {
  const base    = RETRY_DELAYS_MS[attemptNumber] ?? MAX_BACKOFF_MS;
  const jitter  = base * RETRY_JITTER;
  const offset  = (Math.random() * 2 - 1) * jitter;
  return Math.min(Math.round(base + offset), MAX_BACKOFF_MS);
}

// ─── Error classification ─────────────────────────────────────────────────────

type ErrorType = 'timeout' | 'connection_refused' | 'network_error' | 'http_error';

function classifyError(err: unknown): { errorType: ErrorType; errorMessage: string } {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.message.includes('abort')) {
      return { errorType: 'timeout', errorMessage: `Request timed out after ${config.WEBHOOK_TIMEOUT_MS}ms` };
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') {
      return { errorType: 'connection_refused', errorMessage: err.message };
    }
    return { errorType: 'network_error', errorMessage: err.message };
  }
  return { errorType: 'network_error', errorMessage: String(err) };
}

// ─── Main delivery handler ────────────────────────────────────────────────────

async function processWebhookDelivery(job: Job<WebhookDeliveryPayload>): Promise<void> {
  const {
    deliveryId, webhookId, webhookUrl, webhookSecret,
    event, eventId, payload, attemptNumber,
  } = job.data;

  const log = logger.child({ deliveryId, webhookId, event, attemptNumber });

  // ── Idempotency guard ──────────────────────────────────────────────────────
  const delivery = await prisma.webhookDelivery.findUnique({
    where:  { id: deliveryId },
    select: { id: true, delivered: true, failedPermanently: true, attempts: true, maxAttempts: true },
  });

  if (!delivery) {
    log.warn('Delivery record not found — skipping');
    return;
  }
  if (delivery.delivered) {
    log.info('Already delivered — skipping (idempotency guard)');
    return;
  }
  if (delivery.failedPermanently) {
    log.info('Marked as permanently failed — skipping');
    return;
  }

  // ── Build request ──────────────────────────────────────────────────────────
  const body      = JSON.stringify(payload);
  const signature = signWebhookPayload(webhookSecret, body);

  const requestedAt  = new Date();
  let respondedAt: Date | null = null;
  let durationMs: number | null = null;
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorType: ErrorType | null = null;
  let errorMessage: string | null = null;
  let success = false;

  // ── HTTP attempt ───────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Continuum-Signature':  signature,
        'X-Continuum-Event':      event,
        'X-Continuum-Delivery':   deliveryId,
        'X-Continuum-Event-Id':   eventId ?? '',
        'X-Continuum-Attempt':    String(attemptNumber),
        'User-Agent':             'Continuum-Webhooks/1.0',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
    respondedAt = new Date();
    durationMs  = respondedAt.getTime() - requestedAt.getTime();
    statusCode  = response.status;

    const raw   = await response.text();
    responseBody = raw.slice(0, 2_048);
    success      = response.ok;

    if (!success) {
      errorType    = 'http_error';
      errorMessage = `HTTP ${statusCode}`;
    }

    log.info({ statusCode, success, durationMs }, 'Webhook delivery attempt complete');

  } catch (err) {
    clearTimeout(timer);
    respondedAt  = new Date();
    durationMs   = respondedAt.getTime() - requestedAt.getTime();
    const classified = classifyError(err);
    errorType    = classified.errorType;
    errorMessage = classified.errorMessage;
    responseBody = errorMessage;
    log.warn({ errorType, errorMessage, durationMs }, 'Webhook delivery attempt failed');
  }

  // ── Write WebhookAttempt log ───────────────────────────────────────────────
  await prisma.webhookAttempt.create({
    data: {
      id:            randomUUID(),
      deliveryId,
      attemptNumber,
      requestedAt,
      respondedAt,
      durationMs,
      statusCode,
      responseBody:  responseBody?.slice(0, 2_048) ?? null,
      errorType,
      errorMessage:  errorMessage?.slice(0, 500)    ?? null,
      success,
    },
  });

  const newAttemptCount = delivery.attempts + 1;

  // ── Success path ───────────────────────────────────────────────────────────
  if (success) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        delivered:     true,
        attempts:      newAttemptCount,
        lastAttemptAt: respondedAt ?? new Date(),
        statusCode,
        responseBody:  responseBody?.slice(0, 2_048) ?? null,
        nextRetryAt:   null,
        errorMessage:  null,
      },
    });

    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        lastPingAt:         requestedAt,
        lastPingOk:         true,
        totalDeliveries:    { increment: 1 },
        successCount:       { increment: 1 },
        consecutiveFailures: 0,    // reset on any successful delivery
        failureAlertSentAt:  null, // allow next failure streak to alert again
      },
    });

    log.info('Webhook delivered successfully');
    return;
  }

  // ── Failure path ───────────────────────────────────────────────────────────
  const exhausted = newAttemptCount >= delivery.maxAttempts;

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attempts:          newAttemptCount,
      lastAttemptAt:     respondedAt ?? new Date(),
      statusCode,
      responseBody:      responseBody?.slice(0, 2_048) ?? null,
      errorMessage:      errorMessage?.slice(0, 500)    ?? null,
      failedPermanently: exhausted,
      nextRetryAt:       exhausted ? null : new Date(Date.now() + retryDelayMs(newAttemptCount)),
    },
  });

  const updatedWebhook = await prisma.webhook.update({
    where: { id: webhookId },
    data: {
      lastPingAt:          requestedAt,
      lastPingOk:          false,
      totalDeliveries:     { increment: exhausted ? 1 : 0 },
      failureCount:        { increment: exhausted ? 1 : 0 },
      consecutiveFailures: { increment: exhausted ? 1 : 0 },
    },
    select: {
      consecutiveFailures: true,
      failureAlertSentAt:  true,
      url:                 true,
      apiKeyId:            true,
    },
  });

  if (exhausted) {
    log.warn({ attempts: newAttemptCount, maxAttempts: delivery.maxAttempts }, 'Webhook permanently failed — max attempts reached');

    // Fire failure alert if consecutive failures hit threshold and cooldown has passed
    if (updatedWebhook.consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      const cooldownOk = !updatedWebhook.failureAlertSentAt ||
        Date.now() - updatedWebhook.failureAlertSentAt.getTime() >= FAILURE_ALERT_COOLDOWN_MS;
      if (cooldownOk) {
        void sendWebhookFailureAlert(
          webhookId,
          updatedWebhook.url,
          updatedWebhook.apiKeyId,
          updatedWebhook.consecutiveFailures,
        );
      }
    }
    return;
  }

  // ── Retry ──────────────────────────────────────────────────────────────────
  const delay       = retryDelayMs(newAttemptCount);
  const nextRetryAt = new Date(Date.now() + delay);

  await webhookQueue.add(
    'deliver-webhook',
    {
      deliveryId,
      webhookId,
      webhookUrl,
      webhookSecret,
      event,
      eventId: eventId ?? '',
      payload,
      attemptNumber: newAttemptCount + 1,
    },
    {
      delay,
      jobId:    `webhook-${deliveryId}-${newAttemptCount + 1}`,
      priority: 2,
    },
  );

  log.info({ attempts: newAttemptCount, nextRetryAt, delay }, 'Retry scheduled');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export function startWebhookWorker(): void {
  const worker = new Worker<WebhookDeliveryPayload>(
    QUEUE_WEBHOOK,
    processWebhookDelivery,
    {
      connection:      redisConnection,
      concurrency:     5,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ bullJobId: job.id, deliveryId: job.data.deliveryId }, 'Webhook job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { bullJobId: job?.id, deliveryId: job?.data.deliveryId, err },
      'Webhook BullMQ job failed unexpectedly',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Webhook worker error');
  });

  logger.info({ concurrency: 5 }, 'Webhook worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Webhook worker shutting down');
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

export { retryDelayMs as retryDelayMsForTesting };

// Guard: do not auto-start when imported by tests
if (process.env['NODE_ENV'] !== 'test') {
  startWebhookWorker();
}

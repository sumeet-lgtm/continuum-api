/**
 * Send Worker
 *
 * Consumes jobs from the `continuum-send` queue — the delayed jobs that
 * POST /v1/send enqueues for `scheduled_at` sends and PATCH /v1/messages/:id
 * reschedules. Previously nothing consumed this queue: a scheduled send's
 * BullMQ job became ready when its delay expired and then sat unprocessed
 * forever, with the SendMessage row stuck at status "scheduled" and no
 * error surfaced anywhere.
 *
 * Mirrors the immediate-send path in routes/send/index.ts as closely as the
 * job payload allows: same SES call, same DB status update, same
 * email.sent/email.send_failed webhook dispatch, same quota increment only
 * on success. Adds the unsubscribe List-Unsubscribe header unconditionally,
 * matching the immediate path's baseline behavior.
 *
 * Known gap: the immediate path also injects open/click tracking pixels
 * using the sending domain's tracking preferences, which the scheduled-send
 * job payload does not currently carry. Scheduled sends go out without
 * tracking injection until that payload is extended — tracked separately,
 * not silently patched over here.
 *
 * Retries: sendQueue's own defaultJobOptions (attempts: 3, exponential
 * backoff) handle transient failures — a thrown error here is retried by
 * BullMQ. SES-level send failures are caught and recorded as a normal
 * "failed" SendMessage instead, matching how the immediate path never
 * retries a failed send on the caller's behalf.
 */

import { Worker, type Job } from 'bullmq';
import { redisConnection, QUEUE_SEND } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSes, isSesConfigured, SesNotConfiguredError } from '../lib/ses.js';
import { incrementSendUsageBy } from '../plugins/usageMeter.js';
import { dispatchWebhook, buildEventId } from '../lib/webhooks.js';
import { generateUnsubToken } from '../lib/unsubscribe.js';
import { logger } from '../lib/logger.js';
import { initSentry, installCrashReporting } from '../lib/sentry.js';
import type { SendJobPayload } from '../types/job.js';
import type { EmailSentPayload, EmailSendFailedPayload } from '../types/webhook.js';

if (process.env['NODE_ENV'] !== 'test') {
  initSentry('worker-send');
  installCrashReporting('worker-send');
}

async function processScheduledSend(job: Job<SendJobPayload>): Promise<void> {
  const data = job.data;
  const log = logger.child({ sendMessageId: data.sendMessageId, bullJobId: job.id });

  const msg = await prisma.sendMessage.findUnique({ where: { id: data.sendMessageId } });
  if (!msg) {
    log.warn('SendMessage record no longer exists — skipping');
    return;
  }
  // Cancelled via DELETE /v1/messages/:id/cancel, or already processed by a
  // prior attempt that crashed after the SES call but before this guard —
  // either way, sending again would be wrong.
  if (msg.status !== 'scheduled') {
    log.info({ status: msg.status }, 'SendMessage is no longer scheduled — skipping');
    return;
  }

  if (!isSesConfigured()) {
    await prisma.sendMessage.update({
      where: { id: data.sendMessageId },
      data: { status: 'failed', errorMessage: new SesNotConfiguredError().message },
    });
    log.error('SES not configured — cannot send');
    return;
  }

  const unsubToken = generateUnsubToken(data.to, data.apiKeyId);
  const listUnsubscribeHeader = `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`;

  let sesMessageId: string | null = null;
  let status: 'sent' | 'failed' = 'sent';
  let errorMessage: string | null = null;

  try {
    const result = await sendViaSes({
      to: data.to,
      from: data.from,
      subject: data.subject,
      ...(data.cc && data.cc.length ? { cc: data.cc } : {}),
      ...(data.bcc && data.bcc.length ? { bcc: data.bcc } : {}),
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
      ...(data.htmlBody !== undefined ? { htmlBody: data.htmlBody } : {}),
      ...(data.textBody ? { textBody: data.textBody } : {}),
      ...(data.attachments && data.attachments.length ? { attachments: data.attachments } : {}),
      ...(data.headers && Object.keys(data.headers).length ? { headers: data.headers } : {}),
      listUnsubscribeHeader,
    });
    sesMessageId = result.sesMessageId;
  } catch (err) {
    status = 'failed';
    errorMessage = err instanceof SesNotConfiguredError
      ? err.message
      : (err instanceof Error ? err.message : 'Unknown SES error');
    log.error({ err }, 'Scheduled SES send failed');
  }

  await prisma.sendMessage.update({
    where: { id: data.sendMessageId },
    data: {
      sesMessageId, status, errorMessage,
      sentAt: status === 'sent' ? new Date() : null,
    },
  });

  if (status === 'sent') {
    void incrementSendUsageBy(data.apiKeyId, 1);
    const payload: EmailSentPayload = {
      event: 'email.sent', id: data.sendMessageId, to: data.to, subject: data.subject,
      sesMessageId, apiKeyId: data.apiKeyId, sentAt: new Date().toISOString(), apiVersion: '2',
    };
    void dispatchWebhook({
      apiKeyId: data.apiKeyId, event: 'email.sent',
      eventId: buildEventId('email.sent', data.sendMessageId), payload,
    });
  } else {
    const payload: EmailSendFailedPayload = {
      event: 'email.send_failed', id: data.sendMessageId, to: data.to,
      errorMessage, apiKeyId: data.apiKeyId, apiVersion: '2',
    };
    void dispatchWebhook({
      apiKeyId: data.apiKeyId, event: 'email.send_failed',
      eventId: buildEventId('email.send_failed', data.sendMessageId), payload,
    });
  }

  log.info({ status, sesMessageId }, 'Scheduled send processed');
}

export function startSendWorker(): void {
  const worker = new Worker<SendJobPayload>(
    QUEUE_SEND,
    processScheduledSend,
    {
      connection: redisConnection,
      concurrency: 5,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ bullJobId: job.id, sendMessageId: job.data.sendMessageId }, 'Send job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ bullJobId: job?.id, sendMessageId: job?.data.sendMessageId, err }, 'Send BullMQ job failed unexpectedly');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Send worker error');
  });

  logger.info({ concurrency: 5 }, 'Send worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Send worker shutting down');
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export { processScheduledSend as processScheduledSendForTesting };

// Guard: do not auto-start when imported by tests
if (process.env['NODE_ENV'] !== 'test') {
  startSendWorker();

  // Keep the worker alive across transient BullMQ job errors.
  // Uncaught exceptions at startup (missing modules, etc.) still crash.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Send worker: unhandled rejection (worker kept alive)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Send worker: uncaught exception — exiting');
    process.exit(1);
  });
}

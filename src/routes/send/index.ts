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
import { generateUnsubToken, generateUnsubHtml } from '../../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../../lib/tracking.js';
import { processTemplate } from '../../lib/spintax.js';
import { compileMjml } from '../../lib/mjml.js';
import { sendQueue } from '../../lib/queue.js';
import type { SendJobPayload } from '../../types/job.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1), // base64
  content_type: z.string().min(1).max(100),
});

const bodySchema = z.object({
  to: z.string().email().transform((s) => s.trim().toLowerCase()),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().min(1).max(500).optional(),
  html_body: z.string().optional(),
  mjml_body: z.string().optional(),
  text_body: z.string().optional(),
  reply_to: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  headers: z.record(z.string()).optional(),
  tags: z.record(z.string()).optional(),
  idempotency_key: z.string().max(200).optional(),
  scheduled_at: z.string().datetime().optional(),
  template_id: z.string().optional(),
  variables: z.record(z.string()).optional(),
  domain_id: z.string().optional(),
  verify_before_send: z.boolean().default(false),
  track_opens: z.boolean().optional(),
  track_clicks: z.boolean().optional(),
  test: z.boolean().default(false),
}).refine((v) => v.html_body || v.mjml_body || v.text_body || v.template_id, {
  message: 'html_body, text_body, or template_id is required',
}).refine((v) => v.subject || v.template_id, {
  message: 'subject is required when template_id is not provided',
  path: ['subject'],
});

async function buildEmailContent(
  input: z.infer<typeof bodySchema>,
  apiKeyId: string,
): Promise<{ subject: string; htmlBody: string | undefined; textBody: string | undefined }> {
  let subject = input.subject ?? '';
  let htmlBody = input.html_body;
  let textBody = input.text_body;

  // MJML compilation (takes precedence over html_body if both are somehow set)
  if (input.mjml_body && !htmlBody) {
    htmlBody = await compileMjml(input.mjml_body);
  }

  // Template resolution
  if (input.template_id) {
    const tmpl = await prisma.emailTemplate.findFirst({
      where: { id: input.template_id, apiKeyId },
    });
    if (!tmpl) throw Errors.notFound(`Template ${input.template_id} not found.`);
    subject = input.subject || tmpl.subject;
    htmlBody = htmlBody ?? tmpl.htmlBody;
    textBody = textBody ?? (tmpl.textBody ?? undefined);
  }

  // Variable substitution + spintax + liquid
  if (input.variables && Object.keys(input.variables).length > 0) {
    if (htmlBody) htmlBody = processTemplate(htmlBody, input.variables);
    if (textBody) textBody = processTemplate(textBody, input.variables);
    subject = processTemplate(subject, input.variables);
  }

  return { subject, htmlBody, textBody };
}

export async function sendRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/send',
    { preHandler: [requireAuth, requireRateLimit, requireMonthlySendQuota] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const {
        to, cc, bcc, subject: rawSubject, reply_to, attachments, headers, tags,
        idempotency_key, scheduled_at, domain_id, verify_before_send,
        track_opens: requestTrackOpens, track_clicks: requestTrackClicks,
        test: isTestMode,
      } = parsed.data;
      const apiKeyId = request.apiKey.id;

      // ── Idempotency check ──────────────────────────────────────────────────────
      if (idempotency_key) {
        const existing = await prisma.sendMessage.findUnique({
          where: { idempotencyKey: idempotency_key },
          select: { id: true, sesMessageId: true, status: true },
        });
        if (existing) {
          return reply.status(200).send({ id: existing.id, sesMessageId: existing.sesMessageId, status: existing.status, idempotent: true });
        }
      }

      // ── Suppression check ──────────────────────────────────────────────────────
      const suppressed = await prisma.suppression.findUnique({ where: { email: to } });
      if (suppressed) {
        throw Errors.forbidden(`${to} is on the suppression list (${suppressed.reason}) and cannot be sent to.`);
      }

      // ── Verification ───────────────────────────────────────────────────────────
      let verificationId: string | null = null;
      if (verify_before_send) {
        const result = await verifyEmail({ email: to, apiKeyId, bulkJobId: undefined, sourceIp: request.ip });
        verificationId = result.id.startsWith('ephemeral_') ? null : result.id;
        if (result.status === 'invalid' || result.checks.isDisposable) {
          throw Errors.forbidden(`${to} failed verification (status: ${result.status}${result.checks.isDisposable ? ', disposable' : ''}) — refusing to send.`);
        }
      } else {
        try {
          const recent = await prisma.verification.findFirst({
            where: { email: to, apiKeyId }, orderBy: { checkedAt: 'desc' },
            select: { id: true, status: true, isDisposable: true },
          });
          if (recent) verificationId = recent.id;
          if (recent && (recent.status === 'invalid' || recent.isDisposable)) {
            logger.warn({ to, apiKeyId, verificationId }, 'Sending to a previously-flagged address');
          }
        } catch (err) {
          logger.warn({ err, to, apiKeyId }, 'Recent-verification lookup failed — proceeding without it');
        }
      }

      // ── Resolve sending domain ────────────────────────────────────────────────
      let sendingDomain: { id: string; name: string; trackOpens: boolean; trackClicks: boolean; trackingDomain: string | null } | null = null;
      if (domain_id) {
        sendingDomain = await prisma.sendingDomain.findFirst({
          where: { id: domain_id, apiKeyId, status: 'verified' },
          select: { id: true, name: true, trackOpens: true, trackClicks: true, trackingDomain: true },
        });
        if (!sendingDomain) throw Errors.validationFailed([{ field: 'domain_id', message: 'Domain not found or not verified.' }]);
      }

      // ── Build email content ────────────────────────────────────────────────────
      const { subject, htmlBody: rawHtml, textBody } = await buildEmailContent(parsed.data, apiKeyId);

      // ── Scheduled send — queue and return early ───────────────────────────────
      if (scheduled_at) {
        const scheduledDate = new Date(scheduled_at);
        const delayMs = scheduledDate.getTime() - Date.now();
        if (delayMs < 0) throw Errors.validationFailed([{ field: 'scheduled_at', message: 'scheduled_at must be in the future.' }]);

        if (!isSesConfigured()) throw Errors.serviceUnavailable('Send (SES not configured)');

        const record = await prisma.sendMessage.create({
          data: {
            apiKeyId, to, from: buildFromAddress(sendingDomain), subject,
            replyTo: Array.isArray(reply_to) ? reply_to.join(', ') : (reply_to ?? null),
            cc: cc ?? [], bcc: bcc ?? [],
            scheduledAt: scheduledDate, status: 'scheduled',
            domainId: domain_id ?? null,
            idempotencyKey: idempotency_key ?? null,
            tags: tags ?? {},
          },
          select: { id: true, createdAt: true },
        });

        await sendQueue.add('send', {
          sendMessageId: record.id, to, subject, htmlBody: rawHtml, textBody,
          from: buildFromAddress(sendingDomain), replyTo: reply_to,
          cc, bcc, attachments, headers, apiKeyId, domainId: domain_id,
        }, { delay: delayMs, jobId: record.id });

        return reply.status(200).send({ id: record.id, status: 'scheduled', scheduled_at });
      }

      // ── Test mode — simulate the send without hitting SES ─────────────────────
      if (isTestMode) {
        const { subject: testSubject, htmlBody: testHtml, textBody: testText } = await buildEmailContent(parsed.data, apiKeyId);
        const testFrom = buildFromAddress(sendingDomain);
        return reply.status(200).send({
          id: `test_${Date.now()}`,
          status: 'simulated',
          test: true,
          to,
          from: testFrom,
          subject: testSubject,
          ...(testHtml !== undefined && { html_body: testHtml }),
          ...(testText !== undefined && { text_body: testText }),
          domain: sendingDomain?.name ?? null,
          track_opens: requestTrackOpens ?? sendingDomain?.trackOpens ?? true,
          track_clicks: requestTrackClicks ?? sendingDomain?.trackClicks ?? true,
          message: 'Test mode: email was rendered but not sent. No SES call was made and no usage was charged.',
        });
      }

      // ── Inject tracking ────────────────────────────────────────────────────────
      if (!isSesConfigured()) throw Errors.serviceUnavailable('Send (SES not configured)');

      const from = buildFromAddress(sendingDomain);
      const trackOpens = requestTrackOpens ?? sendingDomain?.trackOpens ?? true;
      const trackClicks = requestTrackClicks ?? sendingDomain?.trackClicks ?? true;
      const unsubToken = generateUnsubToken(to, apiKeyId);
      const listUnsubscribeHeader = `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`;

      // ── Create DB record first so we get the real ID for tracking tokens ────────
      let record: { id: string; createdAt: Date };
      try {
        record = await prisma.sendMessage.create({
          data: {
            apiKeyId, to, from, subject,
            replyTo: Array.isArray(reply_to) ? reply_to.join(', ') : (reply_to ?? null),
            cc: cc ?? [], bcc: bcc ?? [],
            sesMessageId: null, status: 'queued',
            verificationId,
            domainId: domain_id ?? null,
            idempotencyKey: idempotency_key ?? null,
            tags: tags ?? {},
            trackingToken: (trackOpens || trackClicks) ? 'pending' : null,
          },
          select: { id: true, createdAt: true },
        });
      } catch (err) {
        logger.error({ err, to, apiKeyId }, 'Failed to pre-create SendMessage');
        record = { id: `ephemeral_${Date.now()}`, createdAt: new Date() };
      }

      // Now inject tracking using the real DB record ID
      let htmlBody = rawHtml;
      if (htmlBody) {
        const unsubHtml = generateUnsubHtml(unsubToken);
        htmlBody = htmlBody.replace(/<\/body>/i, `${unsubHtml}</body>`);
        if (trackOpens || trackClicks) {
          const openToken = trackOpens ? generateOpenToken(record.id) : '';
          const clickTokenFn = trackClicks ? (url: string) => generateClickToken(record.id, url) : (_: string) => _;
          const trackingBase = sendingDomain?.trackingDomain ? `https://${sendingDomain.trackingDomain}` : null;
          htmlBody = injectTracking(htmlBody, openToken, clickTokenFn, trackingBase);
        }
      }

      // ── SES send ────────────────────────────────────────────────────────────────
      let sesMessageId: string | null = null;
      let status: 'sent' | 'failed' = 'sent';
      let errorMessage: string | null = null;

      try {
        const result = await sendViaSes({
          to, from, subject,
          ...(cc && cc.length ? { cc } : {}),
          ...(bcc && bcc.length ? { bcc } : {}),
          ...(reply_to ? { replyTo: reply_to } : {}),
          ...(htmlBody !== undefined ? { htmlBody } : {}),
          ...(textBody ? { textBody } : {}),
          ...(attachments && attachments.length ? { attachments } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          listUnsubscribeHeader,
        });
        sesMessageId = result.sesMessageId;
      } catch (err) {
        status = 'failed';
        errorMessage = err instanceof SesNotConfiguredError
          ? err.message
          : (err instanceof Error ? err.message : 'Unknown SES error');
        logger.error({ err, to, apiKeyId }, 'SES send failed');
      }

      // ── Update DB record with SES result ────────────────────────────────────────
      try {
        await prisma.sendMessage.update({
          where: { id: record.id },
          data: {
            sesMessageId, status, errorMessage,
            sentAt: status === 'sent' ? new Date() : null,
            trackingToken: (trackOpens || trackClicks) ? record.id : null,
          },
        });
      } catch (err) {
        logger.error({ err, to, apiKeyId, sesMessageId, status }, 'Failed to update SendMessage after SES send');
      }

      if (status === 'sent') {
        void incrementSendUsageBy(apiKeyId, 1);
      }

      // ── Webhooks ───────────────────────────────────────────────────────────────
      if (status === 'sent') {
        const payload: EmailSentPayload = {
          event: 'email.sent', id: record.id, to, subject, sesMessageId, apiKeyId,
          sentAt: new Date().toISOString(), apiVersion: '2',
        };
        void dispatchWebhook({ apiKeyId, event: 'email.sent', eventId: buildEventId('email.sent', record.id), payload });
      } else {
        const payload: EmailSendFailedPayload = {
          event: 'email.send_failed', id: record.id, to, errorMessage, apiKeyId, apiVersion: '2',
        };
        void dispatchWebhook({ apiKeyId, event: 'email.send_failed', eventId: buildEventId('email.send_failed', record.id), payload });
      }

      if (status === 'failed') {
        return reply.status(502).send({ id: record.id, status, sesMessageId, errorMessage });
      }
      return reply.status(200).send({ id: record.id, sesMessageId, status });
    },
  );

  // PATCH /v1/messages/:id — update subject, body, or reschedule a scheduled send
  fastify.patch(
    '/messages/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;
      const body = request.body as {
        subject?: string;
        html_body?: string;
        text_body?: string;
        scheduled_at?: string;
      };

      const msg = await prisma.sendMessage.findFirst({
        where: { id, apiKeyId, status: 'scheduled' },
      });
      if (!msg) throw Errors.notFound('Scheduled message not found or not in scheduled state.');

      if (body.scheduled_at !== undefined) {
        const scheduledDate = new Date(body.scheduled_at);
        if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() - Date.now() < 0) {
          throw Errors.validationFailed([{ field: 'scheduled_at', message: 'scheduled_at must be a valid future datetime.' }]);
        }
      }

      const existingJob = await sendQueue.getJob(id);
      // The job for a scheduled send always originated from this same route
      // (the initial POST /v1/send), so its data is a real SendJobPayload —
      // this cast just documents that BullMQ itself only knows it as
      // untyped JSON.
      const existingData = existingJob?.data;
      if (!existingData) throw Errors.notFound('Scheduled message not found or already sent.');

      if (existingJob) await existingJob.remove();

      const newScheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : msg.scheduledAt!;
      const newDelay = Math.max(0, newScheduledAt.getTime() - Date.now());

      const updatedJobData: SendJobPayload = {
        ...existingData,
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.html_body !== undefined ? { htmlBody: body.html_body } : {}),
        ...(body.text_body !== undefined ? { textBody: body.text_body } : {}),
      };

      await sendQueue.add('send', updatedJobData, { delay: newDelay, jobId: id });

      const dbUpdates: Record<string, unknown> = {};
      if (body.subject !== undefined) dbUpdates['subject'] = body.subject;
      if (body.scheduled_at !== undefined) dbUpdates['scheduledAt'] = newScheduledAt;

      const updated = await prisma.sendMessage.update({
        where: { id },
        data: dbUpdates as never,
        select: { id: true, subject: true, scheduledAt: true, status: true },
      });

      return reply.status(200).send({ ...updated, scheduled_at: updated.scheduledAt });
    },
  );

  // DELETE /v1/messages/:id/cancel — cancel scheduled send
  fastify.delete(
    '/messages/:id/cancel',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const msg = await prisma.sendMessage.findFirst({
        where: { id, apiKeyId, status: 'scheduled' },
      });
      if (!msg) throw Errors.notFound('Scheduled message not found.');

      // Remove from BullMQ
      const job = await sendQueue.getJob(id);
      if (job) await job.remove();

      await prisma.sendMessage.update({
        where: { id },
        data: { status: 'cancelled' },
      });

      return reply.status(200).send({ cancelled: true, id });
    },
  );
}

function buildFromAddress(domain: { name: string } | null): string {
  if (domain) return `no-reply@${domain.name}`;
  return config.SES_FROM_DOMAIN.includes('@') ? config.SES_FROM_DOMAIN : `no-reply@${config.SES_FROM_DOMAIN}`;
}

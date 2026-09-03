import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { campaignQueue } from '../../lib/queue.js';
import { sendViaSes, isSesConfigured } from '../../lib/ses.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../../lib/tracking.js';
import { generateUnsubToken, generateUnsubHtml } from '../../lib/unsubscribe.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  domain_id: z.string().optional(),
  reply_to: z.string().email().optional(),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  text_body: z.string().optional(),
  preheader: z.string().max(200).optional(),
  subject_b: z.string().min(1).max(500).optional(),
  list_ids: z.array(z.string()).default([]),
  segment_ids: z.array(z.string()).optional(),
  exclude_list_ids: z.array(z.string()).optional(),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  scheduled_at: z.string().datetime().optional(),
});

export async function campaignRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/campaigns
  fastify.post('/campaigns', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { name, from_name, from_email, domain_id, reply_to, subject, html_body, text_body, preheader, subject_b, list_ids, segment_ids, exclude_list_ids, track_opens, track_clicks, scheduled_at } = parsed.data;

    const campaign = await prisma.campaign.create({
      data: {
        apiKeyId, name, fromName: from_name, fromEmail: from_email,
        domainId: domain_id ?? null, replyTo: reply_to ?? null,
        subject, htmlBody: html_body, textBody: text_body ?? null, preheader: preheader ?? null,
        subjectB: subject_b ?? null,
        listIds: list_ids, segmentIds: segment_ids ?? [], excludeListIds: exclude_list_ids ?? [],
        trackOpens: track_opens, trackClicks: track_clicks,
        scheduledAt: scheduled_at ? new Date(scheduled_at) : null,
        status: 'draft',
      },
      select: { id: true, name: true, subject: true, status: true, createdAt: true },
    });
    return reply.status(201).send(campaign);
  });

  // GET /v1/campaigns
  fastify.get('/campaigns', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10)));

    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where: { apiKeyId, ...(q.status ? { status: q.status } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        select: { id: true, name: true, subject: true, subjectB: true, fromName: true, fromEmail: true, status: true, totalRecipients: true, sentCount: true, openCount: true, clickCount: true, openCountB: true, clickCountB: true, bounceCount: true, complaintCount: true, trackOpens: true, trackClicks: true, createdAt: true, scheduledAt: true, sentAt: true },
      }),
      prisma.campaign.count({ where: { apiKeyId, ...(q.status ? { status: q.status } : {}) } }),
    ]);
    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/campaigns/:id
  fastify.get('/campaigns/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    return reply.status(200).send(campaign);
  });

  // PATCH /v1/campaigns/:id
  fastify.patch('/campaigns/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    if (campaign.status !== 'draft') throw Errors.forbidden('Only draft campaigns can be edited.');

    const parsed = createSchema.partial().safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { name, from_name, from_email, domain_id, reply_to, subject, html_body, text_body, preheader, subject_b, list_ids, segment_ids, exclude_list_ids, track_opens, track_clicks, scheduled_at } = parsed.data;

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(name && { name }), ...(from_name && { fromName: from_name }),
        ...(from_email && { fromEmail: from_email }), ...(domain_id !== undefined && { domainId: domain_id }),
        ...(reply_to !== undefined && { replyTo: reply_to }), ...(subject && { subject }),
        ...(html_body && { htmlBody: html_body }), ...(text_body !== undefined && { textBody: text_body }),
        ...(preheader !== undefined && { preheader: preheader ?? null }),
        ...(subject_b !== undefined && { subjectB: subject_b ?? null }),
        ...(list_ids && { listIds: list_ids }), ...(segment_ids && { segmentIds: segment_ids }),
        ...(exclude_list_ids && { excludeListIds: exclude_list_ids }),
        ...(track_opens !== undefined && { trackOpens: track_opens }),
        ...(track_clicks !== undefined && { trackClicks: track_clicks }),
        ...(scheduled_at !== undefined && { scheduledAt: scheduled_at ? new Date(scheduled_at) : null }),
      },
      select: { id: true, status: true, updatedAt: true },
    });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/campaigns/:id
  fastify.delete('/campaigns/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    if (!['draft', 'cancelled'].includes(campaign.status)) throw Errors.forbidden('Only draft/cancelled campaigns can be deleted.');
    await prisma.campaign.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });

  // POST /v1/campaigns/:id/send
  fastify.post('/campaigns/:id/send', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    if (!['draft', 'scheduled'].includes(campaign.status)) throw Errors.forbidden('Campaign cannot be sent in its current state.');

    const delay = campaign.scheduledAt ? Math.max(0, campaign.scheduledAt.getTime() - Date.now()) : 0;

    await prisma.campaign.update({ where: { id }, data: { status: delay > 0 ? 'scheduled' : 'sending' } });
    await campaignQueue.add('send-campaign', { campaignId: id, apiKeyId }, { delay, jobId: `campaign-${id}` });

    return reply.status(200).send({ started: true, id, status: delay > 0 ? 'scheduled' : 'sending' });
  });

  // POST /v1/campaigns/:id/cancel
  fastify.post('/campaigns/:id/cancel', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    if (!['scheduled', 'sending'].includes(campaign.status)) throw Errors.forbidden('Only scheduled or sending campaigns can be cancelled.');

    const job = await campaignQueue.getJob(`campaign-${id}`);
    if (job) await job.remove().catch(() => { /* already running */ });

    await prisma.campaign.update({ where: { id }, data: { status: 'cancelled' } });
    return reply.status(200).send({ cancelled: true, id });
  });

  // POST /v1/campaigns/:id/duplicate
  fastify.post('/campaigns/:id/duplicate', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');

    const copy = await prisma.campaign.create({
      data: {
        apiKeyId, name: `${campaign.name} (Copy)`,
        fromName: campaign.fromName, fromEmail: campaign.fromEmail,
        domainId: campaign.domainId, replyTo: campaign.replyTo,
        subject: campaign.subject, htmlBody: campaign.htmlBody, textBody: campaign.textBody,
        listIds: campaign.listIds, segmentIds: campaign.segmentIds, excludeListIds: campaign.excludeListIds,
        trackOpens: campaign.trackOpens, trackClicks: campaign.trackClicks,
        status: 'draft',
      },
      select: { id: true, status: true, createdAt: true },
    });
    return reply.status(201).send(copy);
  });

  // POST /v1/campaigns/:id/test — send preview to a single address
  fastify.post('/campaigns/:id/test', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = z.object({ to: z.string().email() }).safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    const { to } = parsed.data;

    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');
    if (!isSesConfigured()) throw Errors.serviceUnavailable('Email sending (SES not configured)');

    const unsubToken = generateUnsubToken(to, apiKeyId);
    let html = campaign.htmlBody + generateUnsubHtml(unsubToken);
    const fakeMessageId = `test_${id}_${Date.now()}`;
    html = injectTracking(html, generateOpenToken(fakeMessageId), (url) => generateClickToken(fakeMessageId, url), null);

    await sendViaSes({
      to,
      from: `${campaign.fromName} <${campaign.fromEmail}>`,
      subject: `[TEST] ${campaign.subject}`,
      htmlBody: html,
      ...(campaign.textBody ? { textBody: campaign.textBody } : {}),
      listUnsubscribeHeader: `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`,
    });

    return reply.status(200).send({ sent: true, to, subject: `[TEST] ${campaign.subject}` });
  });

  // POST /v1/campaigns/:id/spam-check — analyze HTML body for spam triggers before send
  fastify.post('/campaigns/:id/spam-check', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const campaign = await prisma.campaign.findFirst({ where: { id, apiKeyId } });
    if (!campaign) throw Errors.notFound('Campaign not found.');

    const html = campaign.htmlBody;
    const subject = campaign.subject;
    const flags: Array<{ severity: 'low' | 'medium' | 'high'; message: string }> = [];

    // Subject checks
    if (/\bfree\b|\bwin\b|\bcash\b|\bclaim\b/i.test(subject))
      flags.push({ severity: 'high', message: 'Subject contains spam trigger words (free, win, cash, claim)' });
    if (/!!!|€€€|\$\$\$/.test(subject))
      flags.push({ severity: 'high', message: 'Subject contains consecutive exclamation marks or currency symbols' });
    if (subject === subject.toUpperCase() && subject.length > 10)
      flags.push({ severity: 'medium', message: 'Subject is all uppercase' });

    // HTML body checks
    if (!html.toLowerCase().includes('unsubscribe'))
      flags.push({ severity: 'high', message: 'No unsubscribe link found (CAN-SPAM requirement)' });
    if (!html.toLowerCase().includes('<html') || !html.toLowerCase().includes('<body'))
      flags.push({ severity: 'low', message: 'Missing <html>/<body> tags — some clients may render poorly' });
    const imgTags = (html.match(/<img /gi) ?? []).length;
    const textLength = html.replace(/<[^>]+>/g, '').trim().length;
    if (imgTags > 0 && textLength < 50)
      flags.push({ severity: 'medium', message: 'Image-to-text ratio is very high — image-only emails often get filtered' });
    if (html.length > 100_000)
      flags.push({ severity: 'medium', message: 'HTML body is very large (> 100KB) — may be clipped in Gmail' });
    if (/javascript:/i.test(html))
      flags.push({ severity: 'high', message: 'HTML contains javascript: URI — triggers spam filters' });
    if ((html.match(/href=/gi) ?? []).length > 50)
      flags.push({ severity: 'medium', message: 'More than 50 links detected — high link-to-text ratio triggers filters' });
    if (!campaign.textBody)
      flags.push({ severity: 'low', message: 'No plain-text alternative — add a text_body for better deliverability' });

    // Score: 100 = clean, deduct based on severity
    const deductions = flags.reduce((acc, f) => acc + (f.severity === 'high' ? 30 : f.severity === 'medium' ? 10 : 5), 0);
    const score = Math.max(0, 100 - deductions);
    const verdict = score >= 80 ? 'likely_inbox' : score >= 50 ? 'at_risk' : 'likely_spam';

    return reply.send({ campaign_id: id, spam_score: score, verdict, flags });
  });

  // GET /v1/campaigns/:id/health — real-time deliverability health for a campaign
  // Returns bounce rate, complaint rate, open rate, spam signal score 0-100
  fastify.get('/campaigns/:id/health', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const campaign = await prisma.campaign.findFirst({
      where: { id, apiKeyId },
      select: {
        id: true, name: true, status: true, totalRecipients: true,
        sentCount: true, deliveredCount: true, openCount: true, clickCount: true,
        bounceCount: true, complaintCount: true, sentAt: true,
      },
    });
    if (!campaign) throw Errors.notFound('Campaign not found.');

    const sent = campaign.sentCount || 1; // avoid div-by-zero
    const bounceRate = campaign.bounceCount / sent;
    const complaintRate = campaign.complaintCount / sent;
    const openRate = campaign.openCount / sent;
    const clickRate = campaign.clickCount / sent;
    const deliveryRate = campaign.deliveredCount / sent;

    // Spam signal score: 0 (bad) to 100 (perfect)
    // Weights: bounce rate 50pts, complaint rate 30pts, delivery rate 20pts
    const bounceScore = Math.max(0, 50 - Math.round(bounceRate * 1000)); // 5% bounce = 0pts
    const complaintScore = Math.max(0, 30 - Math.round(complaintRate * 3000)); // 1% complaint = 0pts
    const deliveryScore = Math.round(deliveryRate * 20);
    const healthScore = Math.min(100, bounceScore + complaintScore + deliveryScore);

    // Signal flags
    const signals: Array<{ type: 'warning' | 'critical' | 'good'; message: string }> = [];
    if (bounceRate > 0.05) signals.push({ type: 'critical', message: `High bounce rate: ${(bounceRate * 100).toFixed(1)}% (limit: 5%)` });
    else if (bounceRate > 0.02) signals.push({ type: 'warning', message: `Elevated bounce rate: ${(bounceRate * 100).toFixed(1)}%` });
    if (complaintRate > 0.001) signals.push({ type: 'critical', message: `Complaint rate above threshold: ${(complaintRate * 100).toFixed(2)}% (limit: 0.1%)` });
    if (deliveryRate < 0.9) signals.push({ type: 'warning', message: `Low delivery rate: ${(deliveryRate * 100).toFixed(1)}%` });
    if (signals.length === 0 && sent > 10) signals.push({ type: 'good', message: 'All deliverability metrics within healthy range' });

    return reply.status(200).send({
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      status: campaign.status,
      health_score: healthScore,
      signals,
      metrics: {
        total_recipients: campaign.totalRecipients,
        sent: campaign.sentCount,
        delivered: campaign.deliveredCount,
        opened: campaign.openCount,
        clicked: campaign.clickCount,
        bounced: campaign.bounceCount,
        complained: campaign.complaintCount,
        delivery_rate: parseFloat((deliveryRate * 100).toFixed(2)),
        open_rate: parseFloat((openRate * 100).toFixed(2)),
        click_rate: parseFloat((clickRate * 100).toFixed(2)),
        bounce_rate: parseFloat((bounceRate * 100).toFixed(2)),
        complaint_rate: parseFloat((complaintRate * 100).toFixed(3)),
      },
      sent_at: campaign.sentAt,
    });
  });
}

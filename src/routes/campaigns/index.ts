import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { campaignQueue } from '../../lib/queue.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  domain_id: z.string().optional(),
  reply_to: z.string().email().optional(),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  text_body: z.string().optional(),
  list_ids: z.array(z.string()).min(1),
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
    const { name, from_name, from_email, domain_id, reply_to, subject, html_body, text_body, list_ids, segment_ids, exclude_list_ids, track_opens, track_clicks, scheduled_at } = parsed.data;

    const campaign = await prisma.campaign.create({
      data: {
        apiKeyId, fromName: from_name, fromEmail: from_email,
        domainId: domain_id ?? null, replyTo: reply_to ?? null,
        subject, htmlBody: html_body, textBody: text_body ?? null,
        trackOpens: track_opens, trackClicks: track_clicks,
        scheduledAt: scheduled_at ? new Date(scheduled_at) : null,
        status: 'draft',
      },
      select: { id: true, subject: true, status: true, createdAt: true },
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
        select: { id: true, subject: true, status: true, totalRecipients: true, sentCount: true, openCount: true, clickCount: true, createdAt: true, sentAt: true },
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

    const { name, from_name, from_email, domain_id, reply_to, subject, html_body, text_body, list_ids, segment_ids, exclude_list_ids, track_opens, track_clicks, scheduled_at } = parsed.data;

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(name && { name }), ...(from_name && { fromName: from_name }),
        ...(from_email && { fromEmail: from_email }), ...(domain_id !== undefined && { domainId: domain_id }),
        ...(reply_to !== undefined && { replyTo: reply_to }), ...(subject && { subject }),
        ...(html_body && { htmlBody: html_body }), ...(text_body !== undefined && { textBody: text_body }),
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
}

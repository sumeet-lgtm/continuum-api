import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

interface StatsQuery {
  dateFrom?: string;
  dateTo?: string;
  domain_id?: string;
}

function buildWhere(apiKeyId: string, q: StatsQuery): Record<string, unknown> {
  const where: Record<string, unknown> = { apiKeyId };
  if (q.domain_id) where['domainId'] = q.domain_id;
  if (q.dateFrom || q.dateTo) {
    where['createdAt'] = {
      ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
      ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
    };
  }
  return where;
}

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/analytics/sends
  fastify.get(
    '/analytics/sends',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as StatsQuery;
      const apiKeyId = request.apiKey.id;
      const where = buildWhere(apiKeyId, q);

      const [sent, delivered, bounced, complained, opens, clicks] = await Promise.all([
        prisma.sendMessage.count({ where: { ...where, status: { in: ['sent', 'delivered', 'bounced', 'complained', 'failed'] } } }),
        prisma.sendMessage.count({ where: { ...where, status: 'delivered' } }),
        prisma.sendMessage.count({ where: { ...where, status: 'bounced' } }),
        prisma.sendMessage.count({ where: { ...where, status: 'complained' } }),
        prisma.trackingEvent.count({ where: { type: 'open', sendMessage: { apiKeyId } } }),
        prisma.trackingEvent.count({ where: { type: 'click', sendMessage: { apiKeyId } } }),
      ]);

      return reply.status(200).send({
        sent, delivered, bounced, complained, opens, clicks,
        delivery_rate: sent > 0 ? +(delivered / sent * 100).toFixed(1) : 0,
        open_rate: delivered > 0 ? +(opens / delivered * 100).toFixed(1) : 0,
        click_rate: delivered > 0 ? +(clicks / delivered * 100).toFixed(1) : 0,
        bounce_rate: sent > 0 ? +(bounced / sent * 100).toFixed(1) : 0,
        complaint_rate: sent > 0 ? +(complained / sent * 100).toFixed(1) : 0,
      });
    },
  );

  // GET /v1/analytics/sends/timeline — grouped by day
  fastify.get(
    '/analytics/sends/timeline',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as StatsQuery;
      const apiKeyId = request.apiKey.id;

      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const dateTo = q.dateTo ? new Date(q.dateTo) : new Date();

      const messages = await prisma.sendMessage.findMany({
        where: {
          apiKeyId,
          createdAt: { gte: dateFrom, lte: dateTo },
          ...(q.domain_id ? { domainId: q.domain_id } : {}),
        },
        select: { createdAt: true, status: true },
      });

      // Group by day
      const byDay = new Map<string, { sent: number; delivered: number; bounced: number; complained: number }>();
      for (const msg of messages) {
        const day = msg.createdAt.toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, { sent: 0, delivered: 0, bounced: 0, complained: 0 });
        const d = byDay.get(day)!;
        if (['sent', 'delivered', 'bounced', 'complained', 'failed'].includes(msg.status)) d.sent++;
        if (msg.status === 'delivered') d.delivered++;
        if (msg.status === 'bounced') d.bounced++;
        if (msg.status === 'complained') d.complained++;
      }

      const timeline = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, stats]) => ({ date, ...stats }));

      return reply.status(200).send({ data: timeline });
    },
  );

  // GET /v1/analytics/campaigns — campaign performance
  fastify.get(
    '/analytics/campaigns',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10)));

      const campaigns = await prisma.campaign.findMany({
        where: { apiKeyId, status: { in: ['sent', 'sending'] } },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, subject: true, status: true, sentAt: true,
          totalRecipients: true, sentCount: true, deliveredCount: true,
          openCount: true, clickCount: true, bounceCount: true, complaintCount: true,
        },
      });

      return reply.status(200).send({
        data: campaigns.map(c => ({
          ...c,
          delivery_rate: c.sentCount > 0 ? +(c.deliveredCount / c.sentCount * 100).toFixed(1) : 0,
          open_rate: c.deliveredCount > 0 ? +(c.openCount / c.deliveredCount * 100).toFixed(1) : 0,
          click_rate: c.deliveredCount > 0 ? +(c.clickCount / c.deliveredCount * 100).toFixed(1) : 0,
          bounce_rate: c.sentCount > 0 ? +(c.bounceCount / c.sentCount * 100).toFixed(1) : 0,
        })),
      });
    },
  );

  // GET /v1/analytics/mailboxes
  fastify.get(
    '/analytics/mailboxes',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;

      const mailboxes = await prisma.mailbox.findMany({
        where: { apiKeyId },
        select: { id: true, username: true, type: true, status: true, sentToday: true, dailyLimit: true, warmupConfig: true },
      });

      return reply.status(200).send({ data: mailboxes });
    },
  );

  // GET /v1/analytics/mailboxes/:id — per-mailbox detail with daily breakdown
  fastify.get(
    '/analytics/mailboxes/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const mailbox = await prisma.mailbox.findFirst({
        where: { id, apiKeyId },
        select: {
          id: true, username: true, type: true, status: true,
          sentToday: true, dailyLimit: true, sendDelayMinMs: true, sendDelayMaxMs: true,
          lastErrorMsg: true, lastCheckedAt: true, createdAt: true,
          warmupConfig: true,
        },
      });
      if (!mailbox) throw Errors.notFound('Mailbox not found.');

      // Aggregate sequence sends from this mailbox over last 30 days
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const seqsOnMailbox = await prisma.sequence.findMany({ where: { mailboxId: id }, select: { id: true } });
      const seqIds = seqsOnMailbox.map(s => s.id);
      const enrollments = seqIds.length > 0
        ? await prisma.sequenceEnrollment.findMany({
            where: { sequenceId: { in: seqIds }, enrolledAt: { gte: since } },
            select: { status: true, enrolledAt: true },
          })
        : [];

      const byDay: Record<string, { sent: number; replied: number; bounced: number }> = {};
      for (const e of enrollments) {
        const day = e.enrolledAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { sent: 0, replied: 0, bounced: 0 };
        byDay[day]!.sent++;
        if (e.status === 'replied') byDay[day]!.replied++;
        if (e.status === 'bounced') byDay[day]!.bounced++;
      }

      return reply.status(200).send({
        ...mailbox,
        daily_breakdown: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, stats]) => ({ date, ...stats })),
      });
    },
  );
}

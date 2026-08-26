import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

export async function messagesRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/messages
  fastify.get(
    '/messages',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { status?: string; to?: string; dateFrom?: string; dateTo?: string; page?: string; limit?: string };
      const apiKeyId = request.apiKey.id;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const where: Record<string, unknown> = { apiKeyId };
      if (q.status) where['status'] = q.status;
      if (q.to) where['to'] = q.to.toLowerCase();
      if (q.dateFrom || q.dateTo) {
        where['createdAt'] = {
          ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
          ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
        };
      }

      const [items, total] = await Promise.all([
        prisma.sendMessage.findMany({
          where: where as never,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true, to: true, from: true, subject: true, status: true,
            sesMessageId: true, createdAt: true, sentAt: true, tags: true,
          },
        }),
        prisma.sendMessage.count({ where: where as never }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/messages/:id
  fastify.get(
    '/messages/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const msg = await prisma.sendMessage.findFirst({
        where: { id, apiKeyId },
        include: {
          events: { orderBy: { occurredAt: 'asc' } },
          trackingEvents: { orderBy: { occurredAt: 'asc' } },
        },
      });
      if (!msg) throw Errors.notFound('Message not found.');

      return reply.status(200).send(msg);
    },
  );

  // GET /v1/messages/stats
  fastify.get(
    '/messages/stats',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { dateFrom?: string; dateTo?: string };

      const where: Record<string, unknown> = { apiKeyId };
      if (q.dateFrom || q.dateTo) {
        where['createdAt'] = {
          ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
          ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}),
        };
      }

      const baseWhere = where as Record<string, unknown>;
      const [sent, delivered, bounced, complained, opens, clicks] = await Promise.all([
        prisma.sendMessage.count({ where: { ...baseWhere, status: { in: ['sent', 'delivered', 'bounced', 'complained'] } } as never }),
        prisma.sendMessage.count({ where: { ...baseWhere, status: 'delivered' } as never }),
        prisma.sendMessage.count({ where: { ...baseWhere, status: 'bounced' } as never }),
        prisma.sendMessage.count({ where: { ...baseWhere, status: 'complained' } as never }),
        prisma.trackingEvent.count({ where: { type: 'open', sendMessage: { apiKeyId } } }),
        prisma.trackingEvent.count({ where: { type: 'click', sendMessage: { apiKeyId } } }),
      ]);

      return reply.status(200).send({
        sent,
        delivered,
        bounced,
        complained,
        opens,
        clicks,
        delivery_rate: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
        open_rate: delivered > 0 ? Math.round((opens / delivered) * 100) : 0,
        click_rate: delivered > 0 ? Math.round((clicks / delivered) * 100) : 0,
        bounce_rate: sent > 0 ? Math.round((bounced / sent) * 100) : 0,
      });
    },
  );
}

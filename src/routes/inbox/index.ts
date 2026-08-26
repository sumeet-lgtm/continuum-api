import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

export async function inboxRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/inbox — all replies across mailboxes
  fastify.get('/inbox', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; sequence_id?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    // Find mailboxes owned by this API key
    const mailboxIds = (await prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } })).map(m => m.id);

    const where: Record<string, unknown> = { mailboxId: { in: mailboxIds } };
    if (q.sequence_id) where['enrollmentId'] = { not: null };

    const [items, total] = await Promise.all([
      prisma.replyEvent.findMany({
        where: where as never,
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        include: {
          enrollment: { select: { sequenceId: true, email: true, status: true } },
        },
      }),
      prisma.replyEvent.count({ where: where as never }),
    ]);

    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/inbox/:id
  fastify.get('/inbox/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const mailboxIds = (await prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } })).map(m => m.id);
    const reply_ = await prisma.replyEvent.findFirst({
      where: { id, mailboxId: { in: mailboxIds } },
      include: { enrollment: true },
    });
    if (!reply_) throw Errors.notFound('Reply not found.');
    return reply.status(200).send(reply_);
  });

  // PATCH /v1/inbox/:id — mark as read/archived/etc
  fastify.patch('/inbox/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { lead_status?: string };

    const mailboxIds = (await prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } })).map(m => m.id);
    const event = await prisma.replyEvent.findFirst({ where: { id, mailboxId: { in: mailboxIds } } });
    if (!event) throw Errors.notFound('Reply not found.');

    // Update lead status if enrollment has an email
    if (body.lead_status && event.fromEmail) {
      await prisma.lead.updateMany({
        where: { apiKeyId, email: event.fromEmail.toLowerCase() },
        data: { status: body.lead_status },
      });
    }

    return reply.status(200).send({ updated: true, id });
  });
}

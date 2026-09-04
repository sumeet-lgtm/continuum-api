import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { sendViaSmtp } from '../../lib/smtp.js';

const replySchema = z.object({
  body: z.string().min(1, 'Reply body is required').max(20000),
});

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
          enrollment: {
            select: {
              sequenceId: true,
              email: true,
              status: true,
              sequence: { select: { id: true, name: true } },
            },
          },
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
    const body = request.body as { lead_status?: string; status?: string; is_read?: boolean };

    const mailboxIds = (await prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } })).map(m => m.id);
    const event = await prisma.replyEvent.findFirst({ where: { id, mailboxId: { in: mailboxIds } } });
    if (!event) throw Errors.notFound('Reply not found.');

    const updates: Record<string, unknown> = {};
    if (body.status) updates['status'] = body.status;
    if (body.is_read !== undefined) updates['isRead'] = body.is_read;
    if (Object.keys(updates).length) {
      await prisma.replyEvent.update({ where: { id }, data: updates as never });
    }

    if (body.lead_status && event.fromEmail) {
      await prisma.lead.updateMany({
        where: { apiKeyId, email: event.fromEmail.toLowerCase() },
        data: { status: body.lead_status },
      });
    }

    return reply.status(200).send({ updated: true, id });
  });

  // POST /v1/inbox/:id/reply — send an actual reply, from the mailbox that
  // received the original message, threaded back into the same conversation.
  fastify.post('/inbox/:id/reply', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = replySchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const event = await prisma.replyEvent.findFirst({
      where: { id, mailbox: { apiKeyId } },
      include: { mailbox: true },
    });
    if (!event) throw Errors.notFound('Reply not found.');

    const { mailbox } = event;
    if (!mailbox.host || !(mailbox.passwordEnc || mailbox.oauthTokenEnc)) {
      throw Errors.validationFailed({
        mailbox: 'This mailbox has no working SMTP credentials — check it under Mailboxes before replying.',
      });
    }

    const subject = event.subject && /^re:/i.test(event.subject.trim())
      ? event.subject
      : `Re: ${event.subject ?? '(no subject)'}`;

    // Thread back into the same conversation: reference the prospect's own
    // message if we captured it, falling back to what they themselves were
    // replying to — either still gets picked up by every major mail client's
    // threading, just less precisely the further back it falls.
    const threadId = event.messageId || event.inReplyToMessageId;
    const headers: Record<string, string> = {};
    if (threadId) {
      headers['In-Reply-To'] = `<${threadId}>`;
      headers['References'] = `<${threadId}>`;
    }

    const { body } = parsed.data;
    try {
      await sendViaSmtp(
        {
          host: mailbox.host,
          port: mailbox.port ?? 587,
          username: mailbox.username,
          passwordEnc: mailbox.passwordEnc,
          oauthTokenEnc: mailbox.oauthTokenEnc,
        },
        {
          from: mailbox.username,
          to: event.fromEmail,
          subject,
          textBody: body,
          htmlBody: `<p>${body.replace(/\n/g, '<br>')}</p>`,
          headers,
        },
      );
    } catch (err) {
      // A real SMTP rejection (bad auth, throttled, recipient refused) is
      // the mailbox/recipient's problem, not a malformed request — same
      // "200 with ok:false" shape as the mailbox test-connection endpoint,
      // so the dashboard can show the actual reason instead of a generic
      // error banner.
      return reply.status(200).send({
        sent: false,
        error: err instanceof Error ? err.message : 'SMTP send failed',
      });
    }

    await prisma.replyEvent.update({
      where: { id },
      data: { isRead: true, repliedAt: new Date() },
    });

    return reply.status(200).send({ sent: true, id });
  });
}

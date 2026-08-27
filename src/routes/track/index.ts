import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyOpenToken, verifyClickToken, TRANSPARENT_GIF } from '../../lib/tracking.js';

export async function trackRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /track/open — tracking pixel. Accepts token as path param OR query param.
  // Railway proxy truncates path segments >100 chars, so the injected pixel always uses ?t= query param.
  fastify.get(
    '/track/open',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { t?: string; token?: string };
      const token = q.t ?? q.token ?? '';
      const payload = verifyOpenToken(token);

      if (payload) {
        const msg = await prisma.sendMessage.findUnique({
          where: { id: payload.sendMessageId },
          select: { id: true, to: true, apiKeyId: true },
        });

        if (msg) {
          // Create open event (one per open — analytics keep count)
          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'open',
              userAgent: request.headers['user-agent'] ?? null,
              ip: request.ip ?? null,
            },
          }).catch(() => { /* ignore if already logged */ });

          // Update message status to opened
          await prisma.sendMessage.update({
            where: { id: msg.id },
            data: { status: 'opened' as never },
          }).catch(() => { /* ignore */ });
        }
      }

      return reply
        .status(200)
        .header('Content-Type', 'image/gif')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .header('Pragma', 'no-cache')
        .send(TRANSPARENT_GIF);
    },
  );

  // GET /track/click — click redirect. Same query-param approach as open.
  fastify.get(
    '/track/click',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { t?: string; token?: string };
      const token = q.t ?? q.token ?? '';
      const payload = verifyClickToken(token);

      if (payload) {
        const msg = await prisma.sendMessage.findUnique({
          where: { id: payload.sendMessageId },
          select: { id: true, to: true },
        });

        if (msg) {
          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'click',
              linkUrl: payload.url,
              userAgent: request.headers['user-agent'] ?? null,
              ip: request.ip ?? null,
            },
          }).catch(() => { /* ignore */ });
        }

        return reply.status(302).header('Location', payload.url).send();
      }

      // Invalid token — redirect to safe fallback
      return reply.status(302).header('Location', 'https://continuumapi.com').send();
    },
  );
}

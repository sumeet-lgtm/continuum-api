import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyOpenToken, verifyClickToken, TRANSPARENT_GIF } from '../../lib/tracking.js';

export async function trackRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /track/open/:token — tracking pixel (NO /v1 prefix — registered at root)
  fastify.get(
    '/track/open/:token',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.params as { token: string };
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

  // GET /track/click/:token — click redirect
  fastify.get(
    '/track/click/:token',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.params as { token: string };
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

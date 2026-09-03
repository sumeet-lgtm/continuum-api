import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyOpenToken, verifyClickToken, TRANSPARENT_GIF } from '../../lib/tracking.js';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';

export async function trackRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /track/open — tracking pixel. Accepts token as path param OR query param.
  // Railway proxy truncates path segments >100 chars, so the injected pixel always uses ?t= query param.
  // No API key on this request (it's an anonymous pixel load), so IP-scoped
  // rather than key-scoped rate limiting — this was previously unlimited.
  fastify.get(
    '/track/open',
    { preHandler: [requireIpRateLimit('track-open', 300)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { t?: string; token?: string };
      const token = q.t ?? q.token ?? '';
      const payload = verifyOpenToken(token);

      if (payload) {
        // First try by primary key (transactional sends), then by trackingToken
        // (campaign sends use campaignId_email as the tracking ID stored in
        // trackingToken, not the row's cuid id).
        let msg = await prisma.sendMessage.findUnique({
          where: { id: payload.sendMessageId },
          select: { id: true, to: true, apiKeyId: true, trackingToken: true },
        });
        if (!msg) {
          msg = await prisma.sendMessage.findUnique({
            where: { trackingToken: payload.sendMessageId },
            select: { id: true, to: true, apiKeyId: true, trackingToken: true },
          });
        }

        if (msg) {
          // Extract campaignId from trackingToken (format: ${campaignId}_${email})
          const campaignId = msg.trackingToken?.includes('_')
            ? msg.trackingToken.split('_')[0]
            : null;

          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'open',
              ...(campaignId ? { campaignId } : {}),
              userAgent: request.headers['user-agent'] ?? null,
              ip: request.ip ?? null,
            },
          }).catch(() => { /* ignore if already logged */ });

          await prisma.sendMessage.update({
            where: { id: msg.id },
            data: { status: 'opened' as never },
          }).catch(() => { /* ignore */ });

          // Increment campaign open count for real-time health stats
          if (campaignId) {
            // Check variant to update the right counter (A or B)
            const cr = await prisma.campaignRecipient.findFirst({
              where: { campaignId, email: msg.to },
              select: { variant: true },
            }).catch(() => null);
            const isVariantB = cr?.variant === 'b';
            await prisma.campaign.update({
              where: { id: campaignId },
              data: isVariantB ? { openCountB: { increment: 1 } } : { openCount: { increment: 1 } },
            }).catch(() => { /* non-fatal */ });
          }
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
    { preHandler: [requireIpRateLimit('track-click', 300)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { t?: string; token?: string };
      const token = q.t ?? q.token ?? '';
      const payload = verifyClickToken(token);

      if (payload) {
        let msg = await prisma.sendMessage.findUnique({
          where: { id: payload.sendMessageId },
          select: { id: true, to: true, trackingToken: true },
        });
        if (!msg) {
          msg = await prisma.sendMessage.findUnique({
            where: { trackingToken: payload.sendMessageId },
            select: { id: true, to: true, trackingToken: true },
          });
        }

        if (msg) {
          const campaignId = msg.trackingToken?.includes('_')
            ? msg.trackingToken.split('_')[0]
            : null;

          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'click',
              linkUrl: payload.url,
              ...(campaignId ? { campaignId } : {}),
              userAgent: request.headers['user-agent'] ?? null,
              ip: request.ip ?? null,
            },
          }).catch(() => { /* ignore */ });

          if (campaignId) {
            const crClick = await prisma.campaignRecipient.findFirst({
              where: { campaignId, email: msg.to },
              select: { variant: true },
            }).catch(() => null);
            const isVariantBClick = crClick?.variant === 'b';
            await prisma.campaign.update({
              where: { id: campaignId },
              data: isVariantBClick ? { clickCountB: { increment: 1 } } : { clickCount: { increment: 1 } },
            }).catch(() => { /* non-fatal */ });
          }
        }

        return reply.status(302).header('Location', payload.url).send();
      }

      // Invalid token — redirect to safe fallback
      return reply.status(302).header('Location', 'https://continuumapi.com').send();
    },
  );
}

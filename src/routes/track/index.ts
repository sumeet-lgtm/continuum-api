import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { verifyOpenToken, verifyClickToken, TRANSPARENT_GIF } from '../../lib/tracking.js';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';
import { classifyTrackingEvent, checkIpFanout, type BotReason } from '../../engine/botDetection.js';

// One shared scanner/proxy IP hitting many different recipients' tracking
// links is a pattern the per-event checks (IP block, user-agent, send
// timing) can miss entirely — see checkIpFanout's own comment. Only runs
// when the fast, zero-cost checks didn't already flag the event, since it
// costs a DB round trip.
async function classifyWithFanout(
  fast: { isLikelyBot: boolean; botReason: BotReason | null },
  ip: string | null,
  occurredAt: Date,
): Promise<{ isLikelyBot: boolean; botReason: BotReason | null }> {
  if (fast.isLikelyBot) return fast;
  const isFanout = await checkIpFanout(ip, occurredAt);
  return isFanout ? { isLikelyBot: true, botReason: 'ip_fanout' } : fast;
}

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
          select: { id: true, to: true, apiKeyId: true, trackingToken: true, sentAt: true },
        });
        if (!msg) {
          msg = await prisma.sendMessage.findUnique({
            where: { trackingToken: payload.sendMessageId },
            select: { id: true, to: true, apiKeyId: true, trackingToken: true, sentAt: true },
          });
        }

        if (msg) {
          // Extract campaignId from trackingToken (format: ${campaignId}_${email})
          const campaignId = msg.trackingToken?.includes('_')
            ? msg.trackingToken.split('_')[0]
            : null;

          const occurredAt = new Date();
          const userAgent = request.headers['user-agent'] ?? null;
          const ip = request.ip ?? null;
          const fast = classifyTrackingEvent({ ip, userAgent, sentAt: msg.sentAt, occurredAt });
          const { isLikelyBot, botReason } = await classifyWithFanout(fast, ip, occurredAt);

          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'open',
              ...(campaignId ? { campaignId } : {}),
              userAgent,
              ip,
              occurredAt,
              isLikelyBot,
              botReason,
            },
          }).catch(() => { /* ignore if already logged */ });

          // Apple MPP prefetches this pixel for every MPP-enabled recipient
          // regardless of whether a human ever opens the message — flipping
          // status/counters on that would falsely mark essentially every
          // iOS/macOS Mail recipient "opened" and (via stop_on_open /
          // if_opened, see sequenceWorker.ts) silently end real outreach
          // sequences before a genuine human ever engaged.
          if (!isLikelyBot) {
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
          select: { id: true, to: true, trackingToken: true, sentAt: true },
        });
        if (!msg) {
          msg = await prisma.sendMessage.findUnique({
            where: { trackingToken: payload.sendMessageId },
            select: { id: true, to: true, trackingToken: true, sentAt: true },
          });
        }

        if (msg) {
          const campaignId = msg.trackingToken?.includes('_')
            ? msg.trackingToken.split('_')[0]
            : null;

          const occurredAt = new Date();
          const userAgent = request.headers['user-agent'] ?? null;
          const ip = request.ip ?? null;
          const fast = classifyTrackingEvent({ ip, userAgent, sentAt: msg.sentAt, occurredAt });
          const { isLikelyBot, botReason } = await classifyWithFanout(fast, ip, occurredAt);

          await prisma.trackingEvent.create({
            data: {
              sendMessageId: msg.id,
              email: msg.to,
              type: 'click',
              linkUrl: payload.url,
              ...(campaignId ? { campaignId } : {}),
              userAgent,
              ip,
              occurredAt,
              isLikelyBot,
              botReason,
            },
          }).catch(() => { /* ignore */ });

          // Same reasoning as the open handler above — a security gateway's
          // pre-send link scan shouldn't count as a real click or trigger
          // stop_on_click.
          if (!isLikelyBot && campaignId) {
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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

interface StatsQuery {
  dateFrom?: string;
  date_from?: string;
  dateTo?: string;
  date_to?: string;
  domain_id?: string;
}

function buildWhere(apiKeyId: string, q: StatsQuery): Record<string, unknown> {
  const where: Record<string, unknown> = { apiKeyId };
  if (q.domain_id) where['domainId'] = q.domain_id;
  const from = q.dateFrom ?? q.date_from;
  const to = q.dateTo ?? q.date_to;
  if (from || to) {
    where['createdAt'] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
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

  // GET /v1/analytics/sequences — per-sequence enrollment stats
  fastify.get(
    '/analytics/sequences',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10)));

      const sequences = await prisma.sequence.findMany({
        where: { apiKeyId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, name: true, status: true, createdAt: true },
      });

      const data = await Promise.all(sequences.map(async (seq) => {
        const [total, active, completed, replied, bounced] = await Promise.all([
          prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id } }),
          prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'active' } }),
          prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'completed' } }),
          prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'replied' } }),
          prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'bounced' } }),
        ]);
        return {
          ...seq,
          total_enrolled: total,
          active,
          completed,
          replied,
          bounced,
          reply_rate: total > 0 ? +((replied / total) * 100).toFixed(1) : 0,
          completion_rate: total > 0 ? +((completed / total) * 100).toFixed(1) : 0,
        };
      }));

      return reply.status(200).send({ data });
    },
  );

  // GET /v1/analytics/sequences/:id/variants — A/B variant performance for all steps
  fastify.get(
    '/analytics/sequences/:id/variants',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const sequence = await prisma.sequence.findFirst({ where: { id, apiKeyId }, select: { id: true } });
      if (!sequence) throw Errors.notFound('Sequence not found.');

      const steps = await prisma.sequenceStep.findMany({
        where: { sequenceId: id },
        orderBy: { stepOrder: 'asc' },
        select: { id: true, stepOrder: true, subject: true, variants: true },
      });

      // For each step with variants, count sends per variant tracked via TrackingEvent
      const result = await Promise.all(steps.map(async (step) => {
        if (!step.variants || (step.variants as unknown[]).length === 0) return null;
        const variants = step.variants as Array<{ variantLabel: string; subject: string; weight: number }>;
        return {
          step_id: step.id,
          step_order: step.stepOrder,
          variants: variants.map((v) => ({
            label: v.variantLabel,
            subject: v.subject,
            weight: v.weight,
          })),
        };
      }));

      return reply.status(200).send({ data: result.filter(Boolean) });
    },
  );

  // GET /v1/analytics/verification-accuracy
  //
  // No standalone verifier (ZeroBounce, NeverBounce, MillionVerifier) can
  // produce this number — it requires seeing what actually happened after
  // the verification, which means also being the thing that sends. Every
  // /v1/send call that had a verification behind it (either verify_before_send,
  // or the most recent prior check for that address) links back via
  // SendMessage.verificationId. Cross-referencing that against the real SES
  // bounce/complaint outcome turns "98% accuracy" from an asserted marketing
  // number into a measured one, computed from the customer's own real sends.
  const MIN_SAMPLE_SIZE = 20;
  const ACCURACY_STATUSES = ['valid', 'risky', 'unknown'] as const;

  fastify.get(
    '/analytics/verification-accuracy',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as StatsQuery;
      const since = q.dateFrom ?? q.date_from;

      const attemptedStatuses = ['sent', 'delivered', 'bounced', 'complained'] as const;

      const buckets = await Promise.all(ACCURACY_STATUSES.map(async (verifiedStatus) => {
        const where = {
          apiKeyId,
          status: { in: [...attemptedStatuses] },
          verification: { status: verifiedStatus },
          ...(since ? { createdAt: { gte: new Date(since) } } : {}),
        };

        const [total, bounced, complained] = await Promise.all([
          prisma.sendMessage.count({ where }),
          prisma.sendMessage.count({ where: { ...where, status: 'bounced' } }),
          prisma.sendMessage.count({ where: { ...where, status: 'complained' } }),
        ]);

        const sampleSizeOk = total >= MIN_SAMPLE_SIZE;

        return {
          verified_status: verifiedStatus,
          total_sent: total,
          bounced,
          complained,
          bounce_rate: sampleSizeOk ? +((bounced / total) * 100).toFixed(2) : null,
          complaint_rate: sampleSizeOk ? +((complained / total) * 100).toFixed(2) : null,
          sample_size_ok: sampleSizeOk,
        };
      }));

      const validBucket = buckets.find((b) => b.verified_status === 'valid')!;

      return reply.status(200).send({
        buckets,
        // Headline number: bounce rate for addresses this API key verified as
        // "valid" before actually sending to them. Null (not 0) until there's
        // enough real send volume to mean anything — a measured stat with a
        // sample of 2 is worse than no stat at all.
        measured_accuracy_pct: validBucket.sample_size_ok
          ? +(100 - (validBucket.bounce_rate ?? 0)).toFixed(2)
          : null,
        min_sample_size: MIN_SAMPLE_SIZE,
      });
    },
  );

  // GET /v1/analytics/domains — per sending-domain breakdown
  // Groups send stats by the verified sending domain on each message.
  // Returns rows ordered by send volume descending.
  fastify.get(
    '/analytics/domains',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as StatsQuery;
      const where = buildWhere(apiKeyId, q);

      // Pull all messages that have a domainId, within the requested window
      const messages = await prisma.sendMessage.findMany({
        where: { ...where, domainId: { not: null } },
        select: { domainId: true, status: true },
      });

      // Aggregate counts per domain in memory (avoids a GROUP BY that needs raw SQL)
      const byDomain = new Map<string, { sent: number; delivered: number; bounced: number; complained: number }>();
      for (const msg of messages) {
        const domId = msg.domainId!;
        if (!byDomain.has(domId)) byDomain.set(domId, { sent: 0, delivered: 0, bounced: 0, complained: 0 });
        const d = byDomain.get(domId)!;
        if (['sent', 'delivered', 'bounced', 'complained', 'failed'].includes(msg.status)) d.sent++;
        if (msg.status === 'delivered')  d.delivered++;
        if (msg.status === 'bounced')    d.bounced++;
        if (msg.status === 'complained') d.complained++;
      }

      if (byDomain.size === 0) {
        return reply.status(200).send({ data: [] });
      }

      // Fetch domain names for the IDs we have
      const domainIds = Array.from(byDomain.keys());
      const domains = await prisma.domain.findMany({
        where: { id: { in: domainIds } },
        select: { id: true, domain: true, status: true },
      });
      const domainMap = new Map(domains.map((d) => [d.id, d]));

      const data = Array.from(byDomain.entries())
        .map(([id, stats]) => {
          const dom = domainMap.get(id);
          return {
            domain_id:      id,
            domain:         dom?.domain ?? id,
            domain_status:  dom?.status ?? 'unknown',
            sent:           stats.sent,
            delivered:      stats.delivered,
            bounced:        stats.bounced,
            complained:     stats.complained,
            delivery_rate:  stats.sent > 0 ? +(stats.delivered  / stats.sent * 100).toFixed(1) : 0,
            bounce_rate:    stats.sent > 0 ? +(stats.bounced     / stats.sent * 100).toFixed(1) : 0,
            complaint_rate: stats.sent > 0 ? +(stats.complained  / stats.sent * 100).toFixed(2) : 0,
          };
        })
        .sort((a, b) => b.sent - a.sent);

      return reply.status(200).send({ data });
    },
  );
}

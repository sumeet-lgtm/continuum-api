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
      const domains = await prisma.sendingDomain.findMany({
        where: { id: { in: domainIds } },
        select: { id: true, name: true, status: true },
      });
      const domainMap = new Map(domains.map((d) => [d.id, d]));

      const data = Array.from(byDomain.entries())
        .map(([id, stats]) => {
          const dom = domainMap.get(id);
          return {
            domain_id:      id,
            domain:         dom?.name ?? id,
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

  // GET /v1/analytics/send-time — best day/hour to send campaigns based on historical open patterns
  fastify.get(
    '/analytics/send-time',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { days?: string };
      const lookbackDays = Math.min(180, Math.max(7, parseInt(q.days ?? '90', 10)));
      const since = new Date(Date.now() - lookbackDays * 86_400_000);

      // Pull all opens for sends from this key in the lookback window
      const opens = await prisma.trackingEvent.findMany({
        where: {
          type: 'open',
          occurredAt: { gte: since },
          sendMessage: { apiKeyId },
        },
        select: { occurredAt: true },
      });

      if (opens.length < 10) {
        return reply.send({
          enough_data: false,
          message: `Only ${opens.length} opens in the last ${lookbackDays} days. Need at least 10 for a reliable recommendation.`,
          sample_size: opens.length,
        });
      }

      // Aggregate by (dayOfWeek × hour)
      type Bucket = { opens: number; dayOfWeek: number; hour: number };
      const buckets: Record<string, Bucket> = {};
      for (const { occurredAt } of opens) {
        const d = occurredAt.getUTCDay();   // 0=Sun…6=Sat
        const h = occurredAt.getUTCHours(); // 0-23
        const key = `${d}_${h}`;
        if (!buckets[key]) buckets[key] = { opens: 0, dayOfWeek: d, hour: h };
        buckets[key]!.opens++;
      }

      const sorted = Object.values(buckets).sort((a, b) => b.opens - a.opens);
      const best = sorted[0]!;
      const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

      // Hour-of-day distribution (aggregated across all days)
      const hourDist: Record<number, number> = {};
      for (let h = 0; h < 24; h++) hourDist[h] = 0;
      for (const b of Object.values(buckets)) hourDist[b.hour] = (hourDist[b.hour] ?? 0) + b.opens;

      // Day-of-week distribution (aggregated across all hours)
      const dayDist: Record<number, number> = {};
      for (let d = 0; d < 7; d++) dayDist[d] = 0;
      for (const b of Object.values(buckets)) dayDist[b.dayOfWeek] = (dayDist[b.dayOfWeek] ?? 0) + b.opens;

      return reply.send({
        enough_data: true,
        sample_size: opens.length,
        lookback_days: lookbackDays,
        recommendation: {
          day_of_week: best.dayOfWeek,
          day_name: DAYS[best.dayOfWeek],
          hour_utc: best.hour,
          opens_in_slot: best.opens,
          label: `${DAYS[best.dayOfWeek]} at ${best.hour.toString().padStart(2,'0')}:00 UTC`,
        },
        top_5_slots: sorted.slice(0, 5).map(b => ({
          day_name: DAYS[b.dayOfWeek],
          hour_utc: b.hour,
          opens: b.opens,
          label: `${DAYS[b.dayOfWeek]} ${b.hour.toString().padStart(2,'0')}:00 UTC`,
        })),
        by_hour_utc: Array.from({ length: 24 }, (_, h) => ({ hour: h, opens: hourDist[h] ?? 0 })),
        by_day_of_week: Array.from({ length: 7 }, (_, d) => ({ day: d, day_name: DAYS[d], opens: dayDist[d] ?? 0 })),
      });
    },
  );

  // GET /v1/analytics/sequences/:id/funnel
  // Per-step open/click/unsubscribe/bounce funnel for a sequence.
  // Shows where contacts drop off and which steps perform best.
  fastify.get(
    '/analytics/sequences/:id/funnel',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const sequence = await prisma.sequence.findFirst({
        where: { id, apiKeyId },
        select: { id: true, name: true },
      });
      if (!sequence) throw Errors.notFound('Sequence not found.');

      const steps = await prisma.sequenceStep.findMany({
        where: { sequenceId: id },
        orderBy: { stepOrder: 'asc' },
        select: { id: true, stepOrder: true, subject: true, delayDays: true },
      });

      if (steps.length === 0) {
        return reply.status(200).send({ sequence_id: id, name: sequence.name, steps: [] });
      }

      // Sent counts per step from CampaignRecipient-equivalent: SequenceEnrollmentLog
      // Use SendMessage rows associated with each step via sequenceStepId
      const stepIds = steps.map(s => s.id);

      // Count sends per step
      const sends = await prisma.sendMessage.groupBy({
        by: ['sequenceStepId'],
        where: { sequenceStepId: { in: stepIds }, status: { in: ['sent', 'delivered', 'bounced', 'complained', 'opened'] } },
        _count: { id: true },
      });
      const sendMap = new Map(sends.map(s => [s.sequenceStepId!, s._count.id]));

      // Count TrackingEvents per step
      const stepSendIds = await prisma.sendMessage.findMany({
        where: { sequenceStepId: { in: stepIds } },
        select: { id: true, sequenceStepId: true, status: true },
      });
      const msgsByStep = new Map<string, string[]>();
      for (const m of stepSendIds) {
        if (!m.sequenceStepId) continue;
        if (!msgsByStep.has(m.sequenceStepId)) msgsByStep.set(m.sequenceStepId, []);
        msgsByStep.get(m.sequenceStepId)!.push(m.id);
      }

      // Aggregate events for all messages at once then bucket by step
      const allMsgIds = stepSendIds.map(m => m.id);
      const events = allMsgIds.length > 0 ? await prisma.trackingEvent.findMany({
        where: { sendMessageId: { in: allMsgIds }, type: { in: ['open', 'click', 'unsubscribe'] } },
        select: { sendMessageId: true, type: true },
      }) : [];

      const msgToStep = new Map(stepSendIds.map(m => [m.id, m.sequenceStepId!]));
      const eventByStep = new Map<string, { opens: number; clicks: number; unsubscribes: number }>();
      for (const ev of events) {
        const stepId = ev.sendMessageId ? msgToStep.get(ev.sendMessageId) : undefined;
        if (!stepId) continue;
        if (!eventByStep.has(stepId)) eventByStep.set(stepId, { opens: 0, clicks: 0, unsubscribes: 0 });
        const e = eventByStep.get(stepId)!;
        if (ev.type === 'open')        e.opens++;
        else if (ev.type === 'click')  e.clicks++;
        else if (ev.type === 'unsubscribe') e.unsubscribes++;
      }

      // Bounce counts per step
      const bouncesByStep = new Map<string, number>();
      for (const m of stepSendIds) {
        if (m.status === 'bounced' && m.sequenceStepId) {
          bouncesByStep.set(m.sequenceStepId, (bouncesByStep.get(m.sequenceStepId) ?? 0) + 1);
        }
      }

      const result = steps.map(step => {
        const sent       = sendMap.get(step.id) ?? 0;
        const ev         = eventByStep.get(step.id) ?? { opens: 0, clicks: 0, unsubscribes: 0 };
        const bounces    = bouncesByStep.get(step.id) ?? 0;
        return {
          step_id:          step.id,
          step_order:       step.stepOrder,
          subject:          step.subject,
          delay_days:       step.delayDays,
          sent,
          opens:            ev.opens,
          clicks:           ev.clicks,
          unsubscribes:     ev.unsubscribes,
          bounces,
          open_rate:        sent > 0 ? parseFloat((ev.opens / sent * 100).toFixed(1)) : 0,
          click_rate:       sent > 0 ? parseFloat((ev.clicks / sent * 100).toFixed(1)) : 0,
          unsubscribe_rate: sent > 0 ? parseFloat((ev.unsubscribes / sent * 100).toFixed(2)) : 0,
          bounce_rate:      sent > 0 ? parseFloat((bounces / sent * 100).toFixed(2)) : 0,
        };
      });

      return reply.status(200).send({ sequence_id: id, name: sequence.name, steps: result });
    },
  );

  // GET /v1/analytics/inbox-providers
  // Breakdown of delivery, open, bounce, and complaint rates grouped by recipient email domain.
  // Normalises the top 6 consumer providers; everything else rolls into "Other (corporate/ISP)".
  fastify.get(
    '/analytics/inbox-providers',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as StatsQuery;
      const where = buildWhere(apiKeyId, q);

      // Map consumer domains to a display label; everything else is "Other"
      const PROVIDER_MAP: Record<string, string> = {
        'gmail.com':     'Gmail',
        'googlemail.com':'Gmail',
        'yahoo.com':     'Yahoo',
        'yahoo.in':      'Yahoo',
        'ymail.com':     'Yahoo',
        'outlook.com':   'Outlook',
        'hotmail.com':   'Outlook',
        'live.com':      'Outlook',
        'icloud.com':    'iCloud',
        'me.com':        'iCloud',
        'mac.com':       'iCloud',
        'aol.com':       'AOL',
        'protonmail.com':'ProtonMail',
        'proton.me':     'ProtonMail',
      };

      // Pull delivery status + recipient address, then get tracking events for those messages
      const messages = await prisma.sendMessage.findMany({ where, select: { id: true, to: true, status: true } });
      const msgIds = messages.map((m) => m.id);
      const trackingEvents = msgIds.length > 0
        ? await prisma.trackingEvent.findMany({
            where: { sendMessageId: { in: msgIds }, type: { in: ['open', 'click'] } },
            select: { sendMessageId: true, type: true },
          })
        : [];

      // Index tracking events by sendMessageId
      const opensSet  = new Set<string>();
      const clicksSet = new Set<string>();
      for (const ev of trackingEvents) {
        if (!ev.sendMessageId) continue;
        if (ev.type === 'open')  opensSet.add(ev.sendMessageId);
        if (ev.type === 'click') clicksSet.add(ev.sendMessageId);
      }

      type ProviderStats = { sent: number; delivered: number; bounced: number; complained: number; opens: number; clicks: number };
      const byProvider = new Map<string, ProviderStats>();

      const zero = (): ProviderStats => ({ sent: 0, delivered: 0, bounced: 0, complained: 0, opens: 0, clicks: 0 });

      for (const msg of messages) {
        const domainPart = (msg.to ?? '').split('@')[1]?.toLowerCase().trim() ?? '';
        const provider = PROVIDER_MAP[domainPart] ?? 'Other (corporate / ISP)';
        if (!byProvider.has(provider)) byProvider.set(provider, zero());
        const s = byProvider.get(provider)!;
        if (['sent', 'delivered', 'bounced', 'complained', 'failed'].includes(msg.status)) s.sent++;
        if (msg.status === 'delivered')  s.delivered++;
        if (msg.status === 'bounced')    s.bounced++;
        if (msg.status === 'complained') s.complained++;
        if (opensSet.has(msg.id))  s.opens++;
        if (clicksSet.has(msg.id)) s.clicks++;
      }

      const data = Array.from(byProvider.entries())
        .map(([provider, s]) => ({
          provider,
          sent:           s.sent,
          delivered:      s.delivered,
          bounced:        s.bounced,
          complained:     s.complained,
          opens:          s.opens,
          clicks:         s.clicks,
          delivery_rate:  s.sent > 0 ? +(s.delivered  / s.sent * 100).toFixed(1) : 0,
          open_rate:      s.sent > 0 ? +(s.opens       / s.sent * 100).toFixed(1) : 0,
          click_rate:     s.sent > 0 ? +(s.clicks      / s.sent * 100).toFixed(1) : 0,
          bounce_rate:    s.sent > 0 ? +(s.bounced     / s.sent * 100).toFixed(2) : 0,
          complaint_rate: s.sent > 0 ? +(s.complained  / s.sent * 100).toFixed(3) : 0,
        }))
        .sort((a, b) => b.sent - a.sent);

      return reply.status(200).send({ data });
    },
  );

  // GET /v1/analytics/send-time — platform-wide optimal send-time heatmap.
  // Returns opens grouped by UTC hour (0-23) and UTC day of week (0=Sun…6=Sat).
  // Useful for scheduling campaigns at the time your audience is most likely to engage.
  fastify.get(
    '/analytics/send-time',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { dateFrom?: string; dateTo?: string };

      const where: Record<string, unknown> = { type: 'open', sendMessage: { apiKeyId } };
      if (q.dateFrom || q.dateTo) {
        where['occurredAt'] = {
          ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
          ...(q.dateTo   ? { lte: new Date(q.dateTo)   } : {}),
        };
      }

      const events = await prisma.trackingEvent.findMany({
        where: where as never,
        select: { occurredAt: true },
        take: 10_000,
        orderBy: { occurredAt: 'desc' },
      });

      const hourCounts = new Array(24).fill(0) as number[];
      const dayCounts  = new Array(7).fill(0) as number[];
      const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0) as number[]);

      for (const { occurredAt } of events) {
        const h = occurredAt.getUTCHours();
        const d = occurredAt.getUTCDay();
        hourCounts[h]++;
        dayCounts[d]++;
        heatmap[d]![h]++;
      }

      const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const total = events.length;

      const topWindows = heatmap
        .flatMap((row, day) => row.map((count, hour) => ({ day, hour, count, day_name: DAY_NAMES[day]! })))
        .filter(w => w.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      return reply.status(200).send({
        total_opens_analyzed: total,
        hour_distribution: hourCounts,
        day_distribution: dayCounts,
        heatmap,
        top_windows: topWindows,
        optimal_hour: total > 0 ? hourCounts.indexOf(Math.max(...hourCounts)) : null,
        optimal_day:  total > 0 ? dayCounts.indexOf(Math.max(...dayCounts))   : null,
        optimal_day_name: total > 0 ? DAY_NAMES[dayCounts.indexOf(Math.max(...dayCounts))] : null,
      });
    },
  );
}

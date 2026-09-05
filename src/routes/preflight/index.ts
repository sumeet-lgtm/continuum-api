import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const bodySchema = z.object({
  list_id: z.string().optional(),
  emails: z.array(z.string().email()).max(50_000).optional(),
}).refine(d => !!d.list_id !== !!d.emails, {
  message: 'Provide exactly one of list_id or emails.',
});

export interface PreflightBreakdown {
  total: number;
  breakdown: { likely_deliverable: number; risky: number; likely_bounce: number; suppressed: number; unknown: number };
  suppressed_reasons: Record<string, number>;
  sample_risky: string[];
}

/**
 * Pure aggregation — split out from the route handler so the actual
 * classification logic (what counts as "risky" vs "likely to bounce" vs
 * "we just don't know") can be unit tested without a full Fastify + Prisma
 * harness.
 */
export function computePreflightBreakdown(
  emails: string[],
  suppressions: { email: string; reason: string }[],
  cacheHits: { email: string; reachable: boolean | null; isCatchAll: boolean | null }[],
): PreflightBreakdown {
  const suppressedMap = new Map(suppressions.map(s => [s.email, s.reason]));
  const cacheMap = new Map(cacheHits.map(c => [c.email, c]));

  let likelyDeliverable = 0, risky = 0, likelyBounce = 0, suppressed = 0, unknown = 0;
  const suppressedReasons: Record<string, number> = {};
  const sampleRisky: string[] = [];

  for (const email of emails) {
    const suppressionReason = suppressedMap.get(email);
    if (suppressionReason) {
      suppressed++;
      suppressedReasons[suppressionReason] = (suppressedReasons[suppressionReason] ?? 0) + 1;
      if (sampleRisky.length < 20) sampleRisky.push(email);
      continue;
    }

    const cached = cacheMap.get(email);
    if (!cached) { unknown++; continue; }

    if (cached.reachable === false) {
      likelyBounce++;
      if (sampleRisky.length < 20) sampleRisky.push(email);
    } else if (cached.isCatchAll) {
      risky++;
      if (sampleRisky.length < 20) sampleRisky.push(email);
    } else if (cached.reachable === true) {
      likelyDeliverable++;
    } else {
      unknown++;
    }
  }

  return {
    total: emails.length,
    breakdown: { likely_deliverable: likelyDeliverable, risky, likely_bounce: likelyBounce, suppressed, unknown },
    suppressed_reasons: suppressedReasons,
    sample_risky: sampleRisky,
  };
}

/**
 * POST /v1/preflight — "will this list bounce?" check before a send.
 *
 * Answers it purely from data we already have (the shared, cross-customer
 * SMTP-verdict cache and the global suppression list) — no new
 * verification credits spent, no new third-party calls made. An address
 * with no cache entry is reported as "unknown", not guessed at; the point
 * is an honest confidence read on what we already know, not a fresh
 * verification pass a customer would separately pay for.
 */
export async function preflightRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/preflight', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { list_id, emails: rawEmails } = parsed.data;

    let emails: string[];
    if (list_id) {
      const list = await prisma.mailingList.findFirst({ where: { id: list_id, apiKeyId } });
      if (!list) throw Errors.notFound('List not found.');

      const memberships = await prisma.contactListMembership.findMany({
        where: { listId: list_id, status: 'subscribed' },
        select: { contact: { select: { email: true } } },
      });
      emails = memberships.map(m => m.contact.email);
    } else {
      emails = [...new Set((rawEmails ?? []).map(e => e.toLowerCase()))];
    }

    if (emails.length === 0) {
      return reply.status(200).send({
        total: 0,
        breakdown: { likely_deliverable: 0, risky: 0, likely_bounce: 0, suppressed: 0, unknown: 0 },
        suppressed_reasons: {},
        sample_risky: [],
      });
    }

    const [suppressions, cacheHits] = await Promise.all([
      prisma.suppression.findMany({
        where: { email: { in: emails } },
        select: { email: true, reason: true },
      }),
      prisma.smtpCache.findMany({
        where: { email: { in: emails }, expiresAt: { gt: new Date() } },
        select: { email: true, reachable: true, isCatchAll: true },
      }),
    ]);

    return reply.status(200).send(computePreflightBreakdown(emails, suppressions, cacheHits));
  });
}

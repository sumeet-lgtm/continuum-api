import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  sendEmail,
  welcomeEmail,
  quotaWarningEmail,
  quotaExceededEmail,
  day1ActivationEmail,
  day3DiscoveryEmail,
  day7CheckInEmail,
  day14ValueEmail,
  day21Email,
  day30Email,
  day45Email,
  day60Email,
  day75Email,
  day90Email,
  featureSpotlightEmail,
  FEATURE_SPOTLIGHTS,
} from '../lib/email.js';
import { getPlanLimit } from '../plugins/usageMeter.js';
import { config } from '../config.js';

// Fixed lifecycle milestones (hours since key creation, ±4h send window —
// same tolerance as the original day1/3/7/14 windows).
const MILESTONES: { day: number; id: string; build: (firstName?: string | null) => { subject: string; html: string } }[] = [
  { day: 21, id: 'day21domain',  build: day21Email },
  { day: 30, id: 'day30plans',   build: day30Email },
  { day: 45, id: 'day45nurture', build: day45Email },
  { day: 60, id: 'day60finder',  build: day60Email },
  { day: 75, id: 'day75warmup',  build: day75Email },
  { day: 90, id: 'day90checkin', build: day90Email },
];

// Feature spotlights: one real feature per send, starting day 17 and
// stepping every 5 days — a subscriber who stays active sees all 37 over
// roughly six months, interleaved with the milestone emails above.
const SPOTLIGHT_SCHEDULE = FEATURE_SPOTLIGHTS.map((spotlight, i) => ({
  day: 17 + i * 5,
  spotlight,
}));

/**
 * Lifecycle email sweep — runs hourly inside the monitor worker.
 *
 * Send-once semantics via the sent_emails table: each email type has a
 * deterministic id; an insert conflict means it was already sent. Quota
 * emails include the month in the id so they naturally re-arm each cycle.
 */

interface KeyRow {
  id: string;
  keyPrefix: string;
  plan: string | null;
  monthlyLimit: number | null;
  currentMonthUsage: number;
  usageResetAt: Date | null;
  ownerId: string | null;
  userId: string | null;
  createdAt: Date;
  email: string | null; // resolved from users when ownerId isn't an email
  firstName: string | null;
}

/** Claim a send slot. Returns false if this email was already sent. */
async function claim(id: string): Promise<boolean> {
  const inserted = await prisma.$executeRaw`
    insert into sent_emails (id) values (${id}) on conflict (id) do nothing`;
  return inserted > 0;
}

/** Release a claimed slot so a failed send retries next sweep. */
async function release(id: string): Promise<void> {
  await prisma.$executeRaw`delete from sent_emails where id = ${id}`
    .catch(() => { /* best effort */ });
}

function recipientOf(key: KeyRow): string | null {
  if (key.ownerId?.includes('@')) return key.ownerId;
  return key.email;
}

async function sendOnce(
  id: string,
  to: string,
  msg: { subject: string; html: string },
): Promise<void> {
  if (!(await claim(id))) return;
  const ok = await sendEmail(to, msg.subject, msg.html);
  if (!ok) await release(id);
}

export async function runEmailSweep(): Promise<void> {
  if (!config.AWS_ACCESS_KEY_ID) return; // SES not configured — skip

  try {
    const keys = await prisma.$queryRaw<KeyRow[]>`
      select k.id, k."keyPrefix", k.plan, k."monthlyLimit", k."currentMonthUsage",
             k."usageResetAt", k."ownerId", k."userId", k."createdAt", u.email, u."firstName"
      from api_keys k
      left join users u on u.id = k."ownerId"
      where k."isActive" = true`;

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    for (const key of keys) {
      const to = recipientOf(key);
      if (!to) continue;

      // Welcome + lifecycle — keys created in the last 14 days
      const ageMs  = Date.now() - new Date(key.createdAt).getTime();
      const ageH   = ageMs / 3600_000; // hours since creation

      if (ageH < 7 * 24) {
        // Send welcome once during the first week window
        await sendOnce(`welcome:${key.id}`, to, welcomeEmail(key.keyPrefix, key.firstName));
      }

      // Day 1 activation nudge — if they signed up 20-28h ago and haven't made a call
      if (ageH >= 20 && ageH < 28 && key.currentMonthUsage === 0) {
        await sendOnce(`day1activation:${key.id}`, to, day1ActivationEmail(key.keyPrefix, key.firstName));
      }

      // Day 3 feature discovery
      if (ageH >= 68 && ageH < 76) {
        await sendOnce(`day3discovery:${key.id}`, to, day3DiscoveryEmail(key.firstName));
      }

      // Day 7 personal check-in (success manager style)
      if (ageH >= 164 && ageH < 172) {
        await sendOnce(`day7checkin:${key.id}`, to, day7CheckInEmail(key.firstName));
      }

      // Day 14 value proof
      if (ageH >= 332 && ageH < 340) {
        await sendOnce(`day14value:${key.id}`, to, day14ValueEmail(key.firstName));
      }

      // Day 21 -> 90 lifecycle milestones
      for (const m of MILESTONES) {
        const windowH = m.day * 24;
        if (ageH >= windowH - 4 && ageH < windowH + 4) {
          await sendOnce(`${m.id}:${key.id}`, to, m.build(key.firstName));
        }
      }

      // Feature spotlights — one real feature per send, day 17 through ~day 197
      for (const { day, spotlight } of SPOTLIGHT_SCHEDULE) {
        const windowH = day * 24;
        if (ageH >= windowH - 4 && ageH < windowH + 4) {
          await sendOnce(`spotlight:${spotlight.tag}:${key.id}`, to, featureSpotlightEmail(spotlight, key.firstName));
        }
      }

      // Quota emails
      const limit = getPlanLimit(key.plan, key.monthlyLimit);
      const used  = key.currentMonthUsage;
      const plan  = key.plan ?? 'free';

      if (used >= limit) {
        const resetsOn = key.usageResetAt
          ? new Date(key.usageResetAt).toISOString().split('T')[0]!
          : 'the 1st of next month';
        await sendOnce(`quota100:${key.id}:${month}`, to, quotaExceededEmail(limit, plan, resetsOn, key.firstName));
      } else if (used >= limit * 0.8) {
        await sendOnce(`quota80:${key.id}:${month}`, to, quotaWarningEmail(used, limit, plan, key.firstName));
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Email sweep failed');
  }
}

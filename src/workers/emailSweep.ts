import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  sendEmail,
  welcomeEmail,
  quotaWarningEmail,
  quotaExceededEmail,
  weeklyDigestEmail,
} from '../lib/email.js';
import { getPlanLimit } from '../plugins/usageMeter.js';
import { config } from '../config.js';

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
  email: string | null; // resolved from profiles when ownerId isn't an email
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
             k."usageResetAt", k."ownerId", k."userId", k."createdAt", p.email
      from api_keys k
      left join profiles p on p."userId" = k."userId"
      where k."isActive" = true`;

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    for (const key of keys) {
      const to = recipientOf(key);
      if (!to) continue;

      // Welcome — keys created in the last 7 days (older keys predate emails;
      // don't greet April signups in July)
      const ageMs = Date.now() - new Date(key.createdAt).getTime();
      if (ageMs < 7 * 24 * 3600 * 1000) {
        await sendOnce(`welcome:${key.id}`, to, welcomeEmail(key.keyPrefix));
      }

      // Quota emails
      const limit = getPlanLimit(key.plan, key.monthlyLimit);
      const used  = key.currentMonthUsage;
      const plan  = key.plan ?? 'free';

      if (used >= limit) {
        const resetsOn = key.usageResetAt
          ? new Date(key.usageResetAt).toISOString().split('T')[0]!
          : 'the 1st of next month';
        await sendOnce(`quota100:${key.id}:${month}`, to, quotaExceededEmail(limit, plan, resetsOn));
      } else if (used >= limit * 0.8) {
        await sendOnce(`quota80:${key.id}:${month}`, to, quotaWarningEmail(used, limit, plan));
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Email sweep failed');
  }
}

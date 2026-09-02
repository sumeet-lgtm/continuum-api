/**
 * Monthly usage metering middleware
 * 
 * Checks if user has exceeded their monthly verification limit.
 * Updates usage count after each verification.
 * Resets usage at the start of each month.
 * 
 * Plan limits:
 *   free:    1,000/month
 *   starter: 5,000/month
 *   growth:  15,000/month
 *   scale:   100,000/month
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { Errors } from './errorHandler.js';
import { logger } from '../lib/logger.js';
import { sendEmail } from '../lib/email.js';

const PLAN_LIMITS: Record<string, number> = {
  free:    1_000,
  starter: 5_000,
  growth:  15_000,
  scale:   100_000,
};

export function getPlanLimit(plan: string | null, monthlyLimit?: number | null): number {
  return PLAN_LIMITS[plan ?? 'free'] ?? monthlyLimit ?? 1_000;
}

// Active-monitor ceiling per plan. Each monitor check consumes a verification
// (and a provider credit), so caps scale with the plan's monthly quota.
const PLAN_MONITOR_LIMITS: Record<string, number> = {
  free:    5,
  starter: 50,
  growth:  200,
  scale:   500,
};

export function getMonitorLimit(plan: string | null): number {
  return PLAN_MONITOR_LIMITS[plan ?? 'free'] ?? PLAN_MONITOR_LIMITS['free']!;
}

// Mailbox ceiling per plan — matches the counts advertised on the pricing
// page. Previously unenforced: any plan could create unlimited mailboxes,
// unlike every other quota in this file.
const PLAN_MAILBOX_LIMITS: Record<string, number> = {
  free:    1,
  starter: 5,
  growth:  25,
  scale:   100,
};

export function getMailboxLimit(plan: string | null): number {
  return PLAN_MAILBOX_LIMITS[plan ?? 'free'] ?? PLAN_MAILBOX_LIMITS['free']!;
}

export async function requireMonthlyQuota(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.apiKey) return;

  const key = request.apiKey;
  const now = new Date();

  try {
    // Keys created without a reset date would otherwise never reset their usage
    if (!key.usageResetAt) {
      const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await prisma.apiKey.update({
        where: { id: key.id },
        data:  { usageResetAt: nextReset },
      });
      key.usageResetAt = nextReset;
    }

    // Check if usage needs to be reset (new month)
    const resetAt = key.usageResetAt ? new Date(key.usageResetAt) : null;
    if (resetAt && now >= resetAt) {
      // Reset usage for new month
      const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          currentMonthUsage: 0,
          usageResetAt: nextReset,
        },
      });
      key.currentMonthUsage = 0;
      key.usageResetAt = nextReset;
    }

    // Get plan limit + any purchased top-up credits (non-expiring)
    const baseLimit = getPlanLimit(key.plan, key.monthlyLimit);
    const extraCredits = (key as { extraVerificationCredits?: number }).extraVerificationCredits ?? 0;
    const limit = baseLimit + extraCredits;

    // Check if over limit
    if (key.currentMonthUsage >= limit) {
      const resetDate = key.usageResetAt
        ? new Date(key.usageResetAt).toISOString().split('T')[0]
        : 'next month';

      void reply.header('X-Usage-Limit', String(limit));
      void reply.header('X-Usage-Used', String(key.currentMonthUsage));
      void reply.header('X-Usage-Reset', resetDate ?? 'next month');

      throw Errors.rateLimited(0);
    }

    // Set usage headers
    void reply.header('X-Usage-Limit', String(limit));
    void reply.header('X-Usage-Remaining', String(Math.max(0, limit - key.currentMonthUsage)));
    void reply.header('X-Usage-Reset', key.usageResetAt
      ? new Date(key.usageResetAt).toISOString().split('T')[0]
      : 'next month');

    // 80% usage alert — fire-and-forget, one per billing month
    const usageAlert = key as { usageAlertEnabled?: boolean; usageAlertSentAt?: Date | null };
    if (
      usageAlert.usageAlertEnabled !== false &&
      key.currentMonthUsage / limit >= 0.8
    ) {
      const sentAt = usageAlert.usageAlertSentAt ? new Date(usageAlert.usageAlertSentAt) : null;
      const alreadySentThisMonth =
        sentAt &&
        sentAt.getFullYear() === now.getFullYear() &&
        sentAt.getMonth() === now.getMonth();

      if (!alreadySentThisMonth) {
        void sendUsageAlert(key.id, key.ownerId ?? key.userId, key.currentMonthUsage, limit);
      }
    }

  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err;
    // Fail open — don't block requests if metering fails
    logger.warn({ err, apiKeyId: key.id }, 'Usage meter check failed — failing open');
  }
}

async function sendUsageAlert(
  keyId: string,
  ownerId: string | null,
  used: number,
  limit: number,
): Promise<void> {
  try {
    const userId = ownerId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    const pct = Math.round((used / limit) * 100);
    const remaining = limit - used;

    await sendEmail(
      user.email,
      `You've used ${pct}% of your Continuum API quota`,
      `<p>Hi,</p>
<p>You've used <strong>${used.toLocaleString()} of ${limit.toLocaleString()} verifications</strong> (${pct}%) this month on Continuum API.</p>
<p>You have <strong>${remaining.toLocaleString()} verifications remaining</strong> until your quota resets.</p>
<p>To avoid disruption, consider <a href="https://app.continuumapi.com/dashboard/billing">upgrading your plan or purchasing additional credits</a>.</p>
<p>— Continuum API</p>`,
    );

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { usageAlertSentAt: new Date() },
    });
  } catch (err) {
    logger.warn({ err, keyId }, 'Failed to send usage alert email');
  }
}

export async function incrementUsage(apiKeyId: string): Promise<void> {
  return incrementUsageBy(apiKeyId, 1);
}

export async function incrementUsageBy(apiKeyId: string, count: number): Promise<void> {
  if (count <= 0) return;
  try {
    await prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { currentMonthUsage: { increment: count } },
    });
  } catch (err) {
    logger.warn({ err, apiKeyId, count }, 'Failed to increment usage counter');
  }
}

// ─── Send quota (Phase 6) ───────────────────────────────────────────────────
// A separate counter/limit from verification usage above — sends and
// verifications have different unit economics. v1 default mirrors the
// verification PLAN_LIMITS until real send volume suggests different numbers.

const PLAN_SEND_LIMITS: Record<string, number> = {
  free:    1_000,
  starter: 5_000,
  growth:  15_000,
  scale:   100_000,
};

export function getSendLimit(plan: string | null, monthlySendLimit?: number | null): number {
  return PLAN_SEND_LIMITS[plan ?? 'free'] ?? monthlySendLimit ?? 500;
}

export async function requireMonthlySendQuota(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.apiKey) return;

  const key = request.apiKey;
  const now = new Date();

  try {
    // Deliberately its OWN column (sendUsageResetAt), not a reuse of the
    // verify path's usageResetAt — see the schema.prisma comment on why
    // sharing one rollover timestamp between two independent counters is a
    // real bug (whichever check fires first each month starves the other's
    // reset for the rest of that month).
    if (!key.sendUsageResetAt) {
      const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await prisma.apiKey.update({
        where: { id: key.id },
        data:  { sendUsageResetAt: nextReset },
      });
      key.sendUsageResetAt = nextReset;
    }

    const resetAt = key.sendUsageResetAt ? new Date(key.sendUsageResetAt) : null;
    if (resetAt && now >= resetAt) {
      const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          currentMonthSendUsage: 0,
          sendUsageResetAt: nextReset,
        },
      });
      key.currentMonthSendUsage = 0;
      key.sendUsageResetAt = nextReset;
    }

    const limit = getSendLimit(key.plan, key.monthlySendLimit);

    if (key.currentMonthSendUsage >= limit) {
      const resetDate = key.sendUsageResetAt
        ? new Date(key.sendUsageResetAt).toISOString().split('T')[0]
        : 'next month';

      void reply.header('X-Send-Usage-Limit', String(limit));
      void reply.header('X-Send-Usage-Used', String(key.currentMonthSendUsage));
      void reply.header('X-Send-Usage-Reset', resetDate ?? 'next month');

      throw Errors.rateLimited(0);
    }

    void reply.header('X-Send-Usage-Limit', String(limit));
    void reply.header('X-Send-Usage-Remaining', String(Math.max(0, limit - key.currentMonthSendUsage)));
    void reply.header('X-Send-Usage-Reset', key.sendUsageResetAt
      ? new Date(key.sendUsageResetAt).toISOString().split('T')[0]
      : 'next month');

  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err;
    logger.warn({ err, apiKeyId: key.id }, 'Send usage meter check failed — failing open');
  }
}

export async function incrementSendUsageBy(apiKeyId: string, count: number): Promise<void> {
  if (count <= 0) return;
  try {
    await prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { currentMonthSendUsage: { increment: count } },
    });
  } catch (err) {
    logger.warn({ err, apiKeyId, count }, 'Failed to increment send usage counter');
  }
}

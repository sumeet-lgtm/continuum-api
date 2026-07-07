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

    // Get plan limit
    const limit = getPlanLimit(key.plan, key.monthlyLimit);

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

  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err;
    // Fail open — don't block requests if metering fails
    logger.warn({ err, apiKeyId: key.id }, 'Usage meter check failed — failing open');
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

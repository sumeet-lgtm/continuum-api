/**
 * scheduledChecks — daily maintenance jobs
 *
 * Fires once per day via a BullMQ repeatable job.
 * Currently handles:
 *   1. API key expiry warnings — 7-day and 1-day advance emails
 */

import { Worker, Queue, type Job } from 'bullmq';
import { redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendEmail } from '../lib/email.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const QUEUE_DAILY = 'continuum:daily-checks';

// ─── Key expiry warnings ───────────────────────────────────────────────────────

const EXPIRY_WARN_DAYS = [7, 1]; // fire at 7 days and 1 day before expiry

async function runKeyExpiryWarnings(): Promise<void> {
  const now  = new Date();
  const sent: string[] = [];

  for (const daysLeft of EXPIRY_WARN_DAYS) {
    const windowStart = new Date(now.getTime() + daysLeft * 24 * 60 * 60 * 1000 - 30 * 60 * 1000); // ±30min window
    const windowEnd   = new Date(now.getTime() + daysLeft * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);

    const expiringKeys = await prisma.apiKey.findMany({
      where: {
        isActive: true,
        expiresAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, label: true, name: true, keyPrefix: true, expiresAt: true, ownerId: true, userId: true },
    });

    for (const key of expiringKeys) {
      // Debounce: check AuditLog so we don't double-send in same window
      const dedupeAction = `api_key.expiry_warning_${daysLeft}d`;
      const recent = await prisma.auditLog.findFirst({
        where: { action: dedupeAction, actorId: key.id, createdAt: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
        select: { id: true },
      });
      if (recent) continue;

      const userId = key.ownerId ?? key.userId;
      if (!userId) continue;

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user?.email) continue;

      const keyLabel = key.label ?? key.name ?? key.keyPrefix ?? key.id.slice(0, 8);
      const expiresAt = key.expiresAt!;

      await sendEmail({
        to: user.email,
        subject: daysLeft === 1
          ? `Your API key expires tomorrow — rotate it now`
          : `Your API key expires in ${daysLeft} days`,
        html: `
          <p>Hi,</p>
          <p>Your Continuum API key is expiring ${daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`}:</p>
          <ul>
            <li><strong>Key:</strong> ${keyLabel}</li>
            <li><strong>Expires:</strong> ${expiresAt.toUTCString()}</li>
          </ul>
          <p>To avoid service interruption, rotate this key before it expires. You can do this from your <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/api-keys">API Keys dashboard</a>.</p>
          <p>The rotate button creates a new key with the same settings and immediately revokes the old one, so it's a safe one-click operation.</p>
          ${daysLeft === 1 ? '<p><strong>⚠️ Any code using this key will stop working at the expiry time above.</strong></p>' : ''}
        `,
      });

      await prisma.auditLog.create({
        data: {
          action:     dedupeAction,
          actorId:    key.id,
          actorEmail: keyLabel,
          targets:    [{ type: 'api_key', id: key.id, name: keyLabel }],
        },
      }).catch(() => {});

      sent.push(`${keyLabel} (${daysLeft}d)`);
    }
  }

  if (sent.length > 0) {
    logger.info({ sent }, 'Key expiry warning emails sent');
  }
}

// ─── Auto-revoke expired keys ──────────────────────────────────────────────────

async function revokeExpiredKeys(): Promise<void> {
  const result = await prisma.apiKey.updateMany({
    where: { isActive: true, expiresAt: { lte: new Date() } },
    data:  { isActive: false, revokedAt: new Date() },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'Expired API keys auto-revoked');
  }
}

// ─── Daily job handler ────────────────────────────────────────────────────────

async function runDailyChecks(_job: Job): Promise<void> {
  logger.info('Daily checks starting');
  await revokeExpiredKeys();
  await runKeyExpiryWarnings();
  logger.info('Daily checks complete');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export async function scheduleDailyChecks(queue: Queue): Promise<void> {
  // One repeatable job per day (at ~06:00 UTC)
  await queue.add(
    'daily-checks',
    {},
    {
      repeat:   { pattern: '0 6 * * *' }, // every day at 06:00 UTC
      jobId:    'daily-checks-singleton',
      priority: 10,
    },
  );
  logger.info('Daily checks scheduled (0 6 * * *)');
}

export function startDailyChecksWorker(): { close(): Promise<void> } {
  const worker = new Worker(QUEUE_DAILY, runDailyChecks, {
    connection:      redisConnection,
    concurrency:     1,
    stalledInterval: 120_000,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Daily checks job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Daily checks worker error');
  });

  logger.info('Daily checks worker started');

  return {
    async close() {
      await worker.close();
    },
  };
}

export { QUEUE_DAILY };

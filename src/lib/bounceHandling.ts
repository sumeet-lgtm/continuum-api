/**
 * Shared bounce/complaint suppression + rate-alerting logic, used by every
 * inbound delivery-event source (SES/SNS today, SMTP2GO going forward if
 * AWS SES production access doesn't come through). Extracted out of
 * routes/send/events.ts so a second transport doesn't have to duplicate the
 * suppression list, 3-strike soft-bounce tracking, and bounce/complaint-rate
 * email alerts — every transport's events funnel through the same suppression
 * list and the same reputation-health alerting, regardless of which ESP the
 * bounce/complaint was reported by.
 */

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { sendEmail } from './email.js';
import { config } from '../config.js';
import { invalidateSmtpCache } from '../engine/smtpCache.js';
import { monitorQueue } from './queue.js';
import type { MonitorRecheckPayload } from '../types/job.js';
import { withTenant, withRlsBypass } from './tenantContext.js';

const BOUNCE_WARN_PCT = 2.0;
const BOUNCE_DANGER_PCT = 5.0;
const COMPLAINT_WARN_PCT = 0.08; // Gmail/Yahoo threshold is 0.1%; warn just below
const COMPLAINT_DANGER_PCT = 0.3; // above this = likely blocklisted
const BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BOUNCE_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const BOUNCE_MIN_SENT = 50;

/**
 * Upsert-by-email: the unique constraint on Suppression.email makes a
 * repeat bounce a no-op. withRlsBypass, not withTenant: Suppression is
 * deliberately global (a hard bounce under ANY tenant's send means the
 * address doesn't work, full stop), and upserting on its globally-unique
 * email column under a withTenant(apiKeyId) scope would make an existing
 * row owned by a different tenant RLS-invisible — Prisma would then try
 * to INSERT instead of no-op, and crash on the unique-constraint
 * violation instead of correctly finding the row.
 */
export async function suppress(
  email: string,
  reason: 'hard_bounce' | 'complaint' | 'soft_bounce',
  apiKeyId: string,
): Promise<void> {
  await withRlsBypass((tx) =>
    tx.suppression.upsert({
      where: { email },
      update: {}, // first reason wins; don't overwrite an existing suppression's cause
      create: { email, reason, apiKeyId },
    }),
  ).catch((err) => {
    logger.error({ err, email, reason }, 'Failed to write suppression');
  });
}

/** 3-strike soft bounce suppression: track transient bounces, suppress after 3 consecutive. */
export async function trackSoftBounce(email: string, apiKeyId: string): Promise<void> {
  try {
    // Check if already hard-suppressed — skip if so. Global read for the
    // same reason as suppress() above: a suppression from a different
    // tenant must still count.
    const existing = await withRlsBypass((tx) => tx.suppression.findUnique({ where: { email } }));
    if (existing) return;

    const track = await prisma.softBounceTrack.upsert({
      where: { email },
      create: { email, apiKeyId: apiKeyId ?? null, bounceCount: 1, lastBounceAt: new Date() },
      update: { bounceCount: { increment: 1 }, lastBounceAt: new Date() },
    });

    logger.info({ email, bounceCount: track.bounceCount }, 'Soft bounce tracked');

    if (track.bounceCount >= 3) {
      await suppress(email, 'soft_bounce', apiKeyId);
      logger.info({ email }, 'Soft bounce threshold reached — email suppressed');
    }
  } catch (err) {
    logger.error({ err, email }, 'Failed to track soft bounce');
  }
}

/**
 * Closed-loop verification correction: a real hard bounce (from whichever
 * transport reported it) is stronger ground truth than any point-in-time SMTP
 * probe (ours or a provider's) — the message was actually attempted and
 * actually rejected.
 */
export async function correctOnGroundTruth(email: string, apiKeyId: string): Promise<void> {
  void checkBounceRate(apiKeyId);
  const lower = email.toLowerCase();
  await invalidateSmtpCache(lower);

  try {
    const monitor = await withTenant(apiKeyId, (tx) =>
      tx.monitor.findFirst({
        where: { email: lower, apiKeyId, isActive: true, pausedAt: null },
        select: { id: true },
      }),
    );
    if (!monitor) return;

    await withTenant(apiKeyId, (tx) =>
      tx.monitor.update({ where: { id: monitor.id }, data: { nextCheckAt: new Date() } }),
    );
    await monitorQueue.add(
      'recheck-single',
      { monitorId: monitor.id, source: 'bounce_ground_truth' } satisfies MonitorRecheckPayload,
      { jobId: `recheck-${monitor.id}-${Date.now()}`, priority: 1 },
    );
    logger.info(
      { email: lower, monitorId: monitor.id },
      'Hard bounce triggered immediate monitor recheck',
    );
  } catch (err) {
    logger.warn({ err, email: lower }, 'Ground-truth monitor recheck failed — non-fatal');
  }
}

export async function checkBounceRate(apiKeyId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - BOUNCE_WINDOW_MS);
    const [sent, bounced] = await withTenant(apiKeyId, (tx) =>
      Promise.all([
        tx.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since } } }),
        tx.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since }, status: 'bounced' } }),
      ]),
    );

    if (sent < BOUNCE_MIN_SENT) return;

    const pct = (bounced / sent) * 100;
    const level = pct >= BOUNCE_DANGER_PCT ? 'critical' : pct >= BOUNCE_WARN_PCT ? 'warning' : null;
    if (!level) return;

    const cooldownSince = new Date(Date.now() - BOUNCE_ALERT_COOLDOWN_MS);
    // These alert rows are keyed by actorId, not apiKeyId (a pre-existing
    // shape mismatch with logAudit()'s usual rows) — withRlsBypass, same as
    // logAudit()'s own internal write, not withTenant.
    const recentAlert = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({
        where: {
          action: `bounce_rate.${level}`,
          actorId: apiKeyId,
          createdAt: { gte: cooldownSince },
        },
        select: { id: true },
      }),
    );
    if (recentAlert) return;

    const apiKey = await withTenant(apiKeyId, (tx) =>
      tx.apiKey.findUnique({
        where: { id: apiKeyId },
        select: { ownerId: true, userId: true, label: true, name: true },
      }),
    );
    if (!apiKey) return;

    const userId = apiKey.ownerId ?? apiKey.userId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    const keyLabel = apiKey.label ?? apiKey.name ?? apiKeyId.slice(0, 8);
    const subject =
      level === 'critical'
        ? `Action required: bounce rate at ${pct.toFixed(1)}% on your account`
        : `Heads up: bounce rate reaching ${pct.toFixed(1)}% — action recommended`;

    await sendEmail({
      to: user.email,
      subject,
      html: `
        <p>Hi,</p>
        <p>Your Continuum account has a ${level === 'critical' ? '<strong>high</strong>' : 'elevated'} email bounce rate over the last 24 hours:</p>
        <ul>
          <li><strong>API key:</strong> ${keyLabel}</li>
          <li><strong>Sent (last 24h):</strong> ${sent.toLocaleString()}</li>
          <li><strong>Bounced:</strong> ${bounced.toLocaleString()}</li>
          <li><strong>Bounce rate:</strong> ${pct.toFixed(1)}%</li>
        </ul>
        ${
          level === 'critical'
            ? '<p><strong>⚠️ Gmail, Yahoo, and Outlook block senders above 5% bounce rate.</strong> If this continues, your sending reputation may be impacted immediately.</p>'
            : '<p>ISPs typically begin throttling at 2% and blocking at 5%. Taking action now prevents deliverability issues.</p>'
        }
        <p><strong>Recommended actions:</strong></p>
        <ul>
          <li>Review and clean your recipient lists — remove unengaged addresses.</li>
          <li>Verify your suppression list includes all previously bounced addresses.</li>
          <li>Use Continuum's email verification API before sending to new lists.</li>
        </ul>
        <p>View your <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/analytics">analytics</a> and <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/suppressions">suppression list</a> in your dashboard.</p>
      `,
    });

    await withRlsBypass((tx) =>
      tx.auditLog.create({
        data: {
          action: `bounce_rate.${level}`,
          actorId: apiKeyId,
          actorEmail: keyLabel,
          targets: [{ type: 'api_key', id: apiKeyId, name: keyLabel }],
        },
      }),
    ).catch(() => {});

    logger.info({ apiKeyId, pct: pct.toFixed(1), level, sent, bounced }, 'Bounce rate alert sent');
  } catch (err) {
    logger.warn({ err, apiKeyId }, 'Bounce rate check failed — non-fatal');
  }
}

export async function checkComplaintRate(apiKeyId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - BOUNCE_WINDOW_MS);
    const [sent, complained] = await withTenant(apiKeyId, (tx) =>
      Promise.all([
        tx.sendMessage.count({ where: { apiKeyId, createdAt: { gte: since } } }),
        tx.sendMessage.count({
          where: { apiKeyId, createdAt: { gte: since }, status: 'complained' },
        }),
      ]),
    );

    if (sent < BOUNCE_MIN_SENT) return;

    const pct = (complained / sent) * 100;
    const level =
      pct >= COMPLAINT_DANGER_PCT ? 'critical' : pct >= COMPLAINT_WARN_PCT ? 'warning' : null;
    if (!level) return;

    const cooldownSince = new Date(Date.now() - BOUNCE_ALERT_COOLDOWN_MS);
    const recentAlert = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({
        where: {
          action: `complaint_rate.${level}`,
          actorId: apiKeyId,
          createdAt: { gte: cooldownSince },
        },
        select: { id: true },
      }),
    );
    if (recentAlert) return;

    const apiKey = await withTenant(apiKeyId, (tx) =>
      tx.apiKey.findUnique({
        where: { id: apiKeyId },
        select: { ownerId: true, userId: true, label: true, name: true },
      }),
    );
    if (!apiKey) return;

    const userId = apiKey.ownerId ?? apiKey.userId;
    if (!userId) return;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return;

    const keyLabel = apiKey.label ?? apiKey.name ?? apiKeyId.slice(0, 8);
    const subject =
      level === 'critical'
        ? `Urgent: spam complaint rate at ${pct.toFixed(2)}% — immediate action required`
        : `Warning: spam complaint rate at ${pct.toFixed(2)}% on your account`;

    await sendEmail({
      to: user.email,
      subject,
      html: `
        <p>Hi,</p>
        <p>Your Continuum account has a ${level === 'critical' ? '<strong>critical</strong>' : 'elevated'} spam complaint rate over the last 24 hours:</p>
        <ul>
          <li><strong>API key:</strong> ${keyLabel}</li>
          <li><strong>Sent (last 24h):</strong> ${sent.toLocaleString()}</li>
          <li><strong>Complained:</strong> ${complained.toLocaleString()}</li>
          <li><strong>Complaint rate:</strong> ${pct.toFixed(2)}%</li>
        </ul>
        ${
          level === 'critical'
            ? '<p><strong>🚨 Gmail and Yahoo actively block senders above 0.3% complaint rate.</strong> You may already be in their blocklist.</p>'
            : '<p>Gmail and Yahoo start filtering at 0.1% complaint rate. You are approaching that threshold.</p>'
        }
        <p><strong>Immediate actions recommended:</strong></p>
        <ul>
          <li>Ensure every email has a clear, one-click unsubscribe link.</li>
          <li>Remove anyone who hasn't engaged in the last 90 days.</li>
          <li>Never send to purchased or scraped lists.</li>
          <li>Check the <a href="${config.APP_URL ?? 'https://app.continuumapi.com'}/dashboard/suppressions">suppression list</a> to ensure complainers are not re-contacted.</li>
        </ul>
      `,
    });

    await withRlsBypass((tx) =>
      tx.auditLog.create({
        data: {
          action: `complaint_rate.${level}`,
          actorId: apiKeyId,
          actorEmail: keyLabel,
          targets: [{ type: 'api_key', id: apiKeyId, name: keyLabel }],
        },
      }),
    ).catch(() => {});

    logger.info(
      { apiKeyId, pct: pct.toFixed(2), level, sent, complained },
      'Complaint rate alert sent',
    );
  } catch (err) {
    logger.warn({ err, apiKeyId }, 'Complaint rate check failed — non-fatal');
  }
}

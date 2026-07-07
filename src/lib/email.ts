import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Transactional email via the Resend REST API.
 *
 * Gated on RESEND_API_KEY — every sender no-ops (with a debug log) when the
 * key is missing, so email is safely "off" in environments without it.
 */

const FROM = `Continuum API <${config.SUPPORT_EMAIL}>`;

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    logger.debug({ to, subject }, 'RESEND_API_KEY not set — email skipped');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ to, subject, status: res.status, body: await res.text() }, 'Resend send failed');
      return false;
    }
    logger.info({ to, subject }, 'Email sent');
    return true;
  } catch (err) {
    logger.warn({ err, to, subject }, 'Resend send errored');
    return false;
  }
}

// ─── Shared layout ────────────────────────────────────────────────────────────

function layout(body: string): string {
  return `
<div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#18181b">
  <div style="font-size:15px;font-weight:600;margin-bottom:24px">Continuum API</div>
  ${body}
  <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0 16px">
  <div style="font-size:12px;color:#71717a">
    Continuum API · email verification &amp; deliverability<br>
    Questions? Just reply to this email.
  </div>
</div>`;
}

const BTN =
  'display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;' +
  'padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500';

// ─── Lifecycle emails ─────────────────────────────────────────────────────────

export function welcomeEmail(keyPrefix: string): { subject: string; html: string } {
  return {
    subject: 'Your Continuum API key is ready',
    html: layout(`
  <h1 style="font-size:20px;margin:0 0 12px">You're set up.</h1>
  <p style="font-size:14px;line-height:1.6">Your API key (<code style="background:#f4f4f5;padding:2px 6px;border-radius:4px">${keyPrefix}…</code>)
  is active with <strong>1,000 free verifications a month</strong>. The full key is on your dashboard — it never travels by email.</p>
  <p style="font-size:14px;line-height:1.6">Verify your first email in 10 seconds:</p>
  <pre style="background:#f4f4f5;padding:14px;border-radius:8px;font-size:12px;overflow-x:auto">curl -X POST https://api.continuumapi.com/v1/verify \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"someone@company.com"}'</pre>
  <p style="margin:24px 0"><a href="https://app.continuumapi.com" style="${BTN}">Open dashboard</a></p>
  <p style="font-size:13px;color:#71717a;line-height:1.6">Docs: <a href="https://continuumapi.com/docs">continuumapi.com/docs</a> — single verify, bulk CSV jobs, monitoring, and webhooks.</p>`),
  };
}

export function quotaWarningEmail(used: number, limit: number, plan: string): { subject: string; html: string } {
  const pct = Math.round((used / limit) * 100);
  return {
    subject: `You've used ${pct}% of your monthly verifications`,
    html: layout(`
  <h1 style="font-size:20px;margin:0 0 12px">${pct}% of quota used</h1>
  <p style="font-size:14px;line-height:1.6">You've verified <strong>${used.toLocaleString()}</strong> of your
  <strong>${limit.toLocaleString()}</strong> monthly emails on the ${plan} plan. At this pace you may hit the limit
  before your quota resets — verifications then return <code>429 QUOTA_EXCEEDED</code> until reset or upgrade.</p>
  <p style="margin:24px 0"><a href="https://app.continuumapi.com/billing" style="${BTN}">See plans</a></p>`),
  };
}

export function quotaExceededEmail(limit: number, plan: string, resetsOn: string): { subject: string; html: string } {
  return {
    subject: 'Monthly verification quota reached',
    html: layout(`
  <h1 style="font-size:20px;margin:0 0 12px">Quota reached</h1>
  <p style="font-size:14px;line-height:1.6">Your ${plan} plan's <strong>${limit.toLocaleString()}</strong> monthly
  verifications are used up. API calls now return <code>429 QUOTA_EXCEEDED</code> until
  <strong>${resetsOn}</strong> — or immediately after an upgrade:</p>
  <ul style="font-size:14px;line-height:1.8;padding-left:20px">
    <li><strong>Starter</strong> — $25/mo, 5,000 verifications</li>
    <li><strong>Growth</strong> — $49/mo, 15,000 verifications</li>
    <li><strong>Scale</strong> — $199/mo, 100,000 verifications</li>
  </ul>
  <p style="margin:24px 0"><a href="https://app.continuumapi.com/billing" style="${BTN}">Upgrade now</a></p>`),
  };
}

export function upgradeConfirmEmail(plan: string, limit: number): { subject: string; html: string } {
  return {
    subject: `You're on the ${plan} plan`,
    html: layout(`
  <h1 style="font-size:20px;margin:0 0 12px">Upgrade confirmed 🎉</h1>
  <p style="font-size:14px;line-height:1.6">Your account is now on the <strong>${plan}</strong> plan with
  <strong>${limit.toLocaleString()}</strong> verifications a month, effective immediately — no key changes needed.</p>
  <p style="margin:24px 0"><a href="https://app.continuumapi.com" style="${BTN}">Open dashboard</a></p>
  <p style="font-size:13px;color:#71717a">Receipt comes separately from Dodo Payments. Manage or cancel any time from Billing.</p>`),
  };
}

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Platform lifecycle email via Amazon SES (direct — no Resend dependency).
 * No-ops when AWS credentials are absent so dev/staging stays quiet.
 */

let _ses: SESv2Client | null = null;
function getSes(): SESv2Client | null {
  if (!config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) return null;
  if (!_ses) {
    _ses = new SESv2Client({
      region: config.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _ses;
}

const FROM = `Continuum API <${config.SUPPORT_EMAIL ?? 'noreply@continuumapi.com'}>`;

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const ses = getSes();
  if (!ses) {
    logger.debug({ to, subject }, 'SES not configured — email skipped');
    return false;
  }
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      },
      ...(config.SES_CONFIGURATION_SET ? { ConfigurationSetName: config.SES_CONFIGURATION_SET } : {}),
    }));
    logger.info({ to, subject }, 'Platform email sent via SES');
    return true;
  } catch (err) {
    logger.warn({ err, to, subject }, 'Platform email SES send failed');
    return false;
  }
}

// ─── Shared layout ─────────────────────────────────────────────────────────────

const LOGO = `<table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:0">
  <tr>
    <td style="background:#000;padding:20px 32px;border-radius:4px 4px 0 0">
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-right:10px;vertical-align:middle">
            <div style="width:24px;height:24px;background:rgba(255,255,255,0.15);border-radius:5px;display:inline-block;line-height:24px;text-align:center;font-size:11px;color:#fff;font-weight:700">C</div>
          </td>
          <td style="vertical-align:middle">
            <span style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#fff">Continuum API</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

const FOOTER = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:0">
  <tr>
    <td style="background:#F9FAFB;border-top:1px solid #E5E7EB;padding:18px 32px;border-radius:0 0 4px 4px">
      <p style="font-family:Inter,-apple-system,sans-serif;font-size:11px;color:#9CA3AF;margin:0;line-height:1.7">
        © 2026 Continuum API &nbsp;·&nbsp;
        <a href="https://app.continuumapi.com/terms" style="color:#9CA3AF">Terms</a>
        &nbsp;·&nbsp;
        <a href="https://app.continuumapi.com/privacy" style="color:#9CA3AF">Privacy</a>
        &nbsp;·&nbsp;
        Questions? Reply to this email.
      </p>
    </td>
  </tr>
</table>`;

const BTN = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;padding:11px 22px;border-radius:6px;margin:8px 0 20px">${label}</a>`;

const DIVIDER = `<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0">`;

const ROW = (label: string, value: string) =>
  `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:1px solid #F3F4F6">
    <tr>
      <td style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;padding:10px 0">${label}</td>
      <td style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#0A0A0A;font-weight:500;padding:10px 0;text-align:right">${value}</td>
    </tr>
  </table>`;

const CODE = (text: string) =>
  `<code style="background:#F3F4F6;border:1px solid #E5E7EB;border-radius:4px;font-family:monospace;font-size:12px;color:#0A0A0A;padding:3px 8px">${text}</code>`;

const ALERT = (color: 'warning' | 'red' | 'green', text: string) => {
  const map = {
    warning: { bg: '#F9FAFB', border: '#374151', text: '#374151' },
    red:     { bg: '#FFF1F2', border: '#F43F5E', text: '#881337' },
    green:   { bg: '#F0FDF4', border: '#22C55E', text: '#14532D' },
  };
  const c = map[color];
  return `<div style="background:${c.bg};border-left:3px solid ${c.border};border-radius:0 4px 4px 0;padding:12px 14px;margin:16px 0;font-family:Inter,-apple-system,sans-serif;font-size:13px;color:${c.text};line-height:1.6">${text}</div>`;
};

function layout(subjectLine: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${subjectLine}</title></head><body style="margin:0;padding:0;background:#F4F4F5">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4F4F5;padding:32px 0">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px">
      <tr><td>${LOGO}</td></tr>
      <tr><td style="background:#fff;padding:32px 32px 24px">
        ${bodyHtml}
      </td></tr>
      <tr><td>${FOOTER}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function p(text: string) {
  return `<p style="font-family:Inter,-apple-system,sans-serif;font-size:14px;line-height:1.7;color:#374151;margin:0 0 14px">${text}</p>`;
}

function h1(text: string) {
  return `<h1 style="font-family:Inter,-apple-system,sans-serif;font-size:20px;font-weight:600;color:#0A0A0A;margin:0 0 14px;line-height:1.3">${text}</h1>`;
}

function greeting(name?: string | null) {
  return `<p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0 0 18px">Hi${name ? ` ${name}` : ''},</p>`;
}

// ─── Onboarding ─────────────────────────────────────────────────────────────────

export function welcomeEmail(keyPrefix: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Your Continuum API key is ready',
    html: layout('Your Continuum API key is ready', `
      ${greeting(firstName)}
      ${h1('Your account is ready.')}
      ${p(`Your API key (${CODE(keyPrefix + '…')}) is active. Start with a verification call or send your first email in under a minute. The full key is on your dashboard — it never travels by email.`)}
      ${p('Quick start:')}
      <pre style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:14px;font-family:monospace;font-size:12px;color:#374151;margin:0 0 20px;overflow-x:auto">curl -X POST https://api.continuumapi.com/v1/verify \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"someone@company.com"}'</pre>
      ${BTN('https://app.continuumapi.com', 'Open Dashboard →')}
      ${DIVIDER}
      ${ROW('API endpoint', '<code style="font-family:monospace;font-size:12px">api.continuumapi.com</code>')}
      ${ROW('Monthly verifications', '500 (free)')}
      ${ROW('Docs', '<a href="https://continuumapi.com/docs" style="color:#374151">continuumapi.com/docs</a>')}
    `),
  };
}

export function loginAlertEmail(opts: { browser: string; location: string; ip: string; time: string; firstName?: string | null }): { subject: string; html: string } {
  return {
    subject: 'New sign-in to your Continuum API account',
    html: layout('New sign-in detected', `
      ${greeting(opts.firstName)}
      ${h1('New sign-in to your account.')}
      ${p('We detected a sign-in to your Continuum API account from a new session.')}
      ${ROW('Time', opts.time)}
      ${ROW('Browser', opts.browser)}
      ${ROW('Location', opts.location)}
      ${ROW('IP address', CODE(opts.ip))}
      ${DIVIDER}
      ${ALERT('red', 'If this wasn\'t you, <a href="https://app.continuumapi.com/dashboard/api-keys" style="color:inherit;font-weight:600">revoke all API keys immediately</a> and contact support.')}
      ${p('<span style="color:#9CA3AF;font-size:12px">If this was you, no action is needed.</span>')}
    `),
  };
}

// ─── Security ───────────────────────────────────────────────────────────────────

export function apiKeyCreatedEmail(keyPrefix: string, keyName: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'New API key created',
    html: layout('New API key created', `
      ${greeting(firstName)}
      ${h1('A new API key was created.')}
      ${p('Store it securely — the full key is shown only once in your dashboard.')}
      ${ROW('Key prefix', CODE(keyPrefix + '…'))}
      ${ROW('Name', keyName)}
      ${ROW('Created', new Date().toUTCString())}
      ${ROW('Permission', 'Full access')}
      ${DIVIDER}
      ${ALERT('warning', 'If you didn\'t create this key, <a href="https://app.continuumapi.com/dashboard/api-keys" style="color:inherit;font-weight:600">revoke it immediately</a>.')}
    `),
  };
}

export function apiKeyRevokedEmail(keyPrefix: string, keyName: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'API key revoked',
    html: layout('API key revoked', `
      ${greeting(firstName)}
      ${h1('An API key was permanently revoked.')}
      ${p('This key will no longer authenticate requests. If your integration depends on it, update now to avoid downtime.')}
      ${ROW('Key prefix', CODE(keyPrefix + '…'))}
      ${ROW('Name', keyName)}
      ${ROW('Revoked at', new Date().toUTCString())}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/api-keys', 'Manage API Keys →')}
    `),
  };
}

// ─── Billing ─────────────────────────────────────────────────────────────────────

export function upgradeConfirmEmail(plan: string, limit: number, firstName?: string | null): { subject: string; html: string } {
  const features: Record<string, string[]> = {
    starter: ['Email verification API', 'Transactional email sending', 'Bulk jobs & webhooks', 'Mailing lists & campaigns'],
    growth:  ['Everything in Starter', 'Cold outreach sequences', 'Multi-mailbox rotation', 'Reply detection', 'Priority support'],
    scale:   ['Everything in Growth', 'Email warmup', 'Inbox placement testing', 'AI personalization', 'Dedicated throughput'],
  };
  const featureList = (features[plan.toLowerCase()] ?? [])
    .map(f => `<li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:3px 0">${f}</li>`)
    .join('');
  return {
    subject: `You're on the ${plan} plan`,
    html: layout(`Upgraded to ${plan}`, `
      ${greeting(firstName)}
      ${h1(`You're on ${plan}.`)}
      ${ALERT('green', `<strong>${limit.toLocaleString()} verifications/month</strong> are now active. Limits reset on the 1st of next month.`)}
      ${ROW('Plan', plan)}
      ${ROW('Monthly quota', limit.toLocaleString())}
      <ul style="padding-left:18px;margin:16px 0">${featureList}</ul>
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard', 'Open Dashboard →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Receipt arrives separately from Dodo Payments. Manage or cancel any time from Billing.</span>')}
    `),
  };
}

export function planDowngradedEmail(plan: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Your Continuum API plan has changed',
    html: layout('Plan changed', `
      ${greeting(firstName)}
      ${h1('Your plan has been updated.')}
      ${p(`Your subscription has ended and your account has been moved to the ${plan === 'free' ? 'free' : plan} plan.`)}
      ${ROW('Current plan', plan)}
      ${ROW('Monthly quota', plan === 'free' ? '500 verifications' : 'See billing')}
      ${DIVIDER}
      ${ALERT('warning', 'If you believe this is an error, reply to this email and we\'ll sort it out.')}
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Reactivate Plan →')}
    `),
  };
}

export function paymentReceiptEmail(opts: { amount: string; plan: string; period: string; invoiceId: string; firstName?: string | null }): { subject: string; html: string } {
  return {
    subject: `Payment confirmed — $${opts.amount} receipt`,
    html: layout('Payment receipt', `
      ${greeting(opts.firstName)}
      ${h1('Payment confirmed.')}
      ${p('Your subscription has been renewed. Here\'s your receipt.')}
      ${ROW('Amount', `<strong style="font-size:16px">$${opts.amount}</strong>`)}
      ${ROW('Plan', opts.plan)}
      ${ROW('Billing period', opts.period)}
      ${ROW('Invoice', CODE(opts.invoiceId))}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Download Invoice →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Payments processed by Dodo Payments.</span>')}
    `),
  };
}

export function paymentFailedEmail(opts: { amount: string; retryDate: string; firstName?: string | null }): { subject: string; html: string } {
  return {
    subject: 'Action required: payment failed',
    html: layout('Payment failed', `
      ${greeting(opts.firstName)}
      ${h1('We couldn\'t process your payment.')}
      ${ALERT('red', `Your $${opts.amount} charge failed. Update your payment method to keep your account active.`)}
      ${ROW('Amount', `$${opts.amount}`)}
      ${ROW('Status', 'Card declined')}
      ${ROW('Next retry', opts.retryDate)}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Update Payment Method')}
      ${p('<span style="color:#9CA3AF;font-size:12px">If not resolved within 3 days, your account will revert to the free plan.</span>')}
    `),
  };
}

export function subscriptionCancelledEmail(plan: string, endsAt: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Your subscription has been cancelled',
    html: layout('Subscription cancelled', `
      ${greeting(firstName)}
      ${h1('Subscription cancelled.')}
      ${p(`Your ${plan} plan has been cancelled. You'll keep access until <strong>${endsAt}</strong>, after which your account moves to the free plan.`)}
      ${ROW('Plan', plan)}
      ${ROW('Access until', endsAt)}
      ${ROW('After expiry', 'Free plan (500 verifications/mo)')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Reactivate →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Changed your mind? You can reactivate at any time before the expiry date.</span>')}
    `),
  };
}

// ─── Usage ───────────────────────────────────────────────────────────────────────

export function quotaWarningEmail(used: number, limit: number, plan: string, firstName?: string | null): { subject: string; html: string } {
  const pct = Math.round((used / limit) * 100);
  return {
    subject: `You've used ${pct}% of your monthly quota`,
    html: layout(`${pct}% quota used`, `
      ${greeting(firstName)}
      ${h1(`You've used ${pct}% of your monthly quota.`)}
      ${p(`At your current rate you may hit the limit before your quota resets on <strong>the 1st of next month</strong>.`)}
      ${ROW('Used', `${used.toLocaleString()} / ${limit.toLocaleString()}`)}
      ${ROW('Remaining', (limit - used).toLocaleString())}
      ${ROW('Plan', plan)}
      <div style="background:#F3F4F6;border-radius:4px;height:6px;margin:8px 0 20px;overflow:hidden">
        <div style="background:#0A0A0A;width:${pct}%;height:100%;border-radius:4px"></div>
      </div>
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Upgrade Plan →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Once you hit 100%, API requests return 429 until the quota resets.</span>')}
    `),
  };
}

export function quotaExceededEmail(limit: number, plan: string, resetsOn: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Monthly quota reached — API returning 429',
    html: layout('Quota reached', `
      ${greeting(firstName)}
      ${h1('You\'ve hit your monthly limit.')}
      ${ALERT('red', `All API requests are now returning ${CODE('429 Too Many Requests')} until your quota resets.`)}
      ${ROW('Used', `${limit.toLocaleString()} / ${limit.toLocaleString()}`)}
      ${ROW('Resets', resetsOn)}
      <div style="background:#F3F4F6;border-radius:4px;height:6px;margin:8px 0 20px;overflow:hidden">
        <div style="background:#EF4444;width:100%;height:100%;border-radius:4px"></div>
      </div>
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Upgrade Now →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Upgrading takes effect immediately — no need to wait for the reset.</span>')}
    `),
  };
}

// ─── Domains ─────────────────────────────────────────────────────────────────────

export function domainVerifiedEmail(domain: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `${domain} verified — ready to send`,
    html: layout('Domain verified', `
      ${greeting(firstName)}
      ${h1(`${domain} is verified.`)}
      ${ALERT('green', 'SPF, DKIM, and DMARC records are all passing. You can now send from any address on this domain.')}
      ${ROW('Domain', domain)}
      ${ROW('SPF', '✓ Valid')}
      ${ROW('DKIM', '✓ Valid')}
      ${ROW('Status', 'Verified')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/domains', 'View Domain Settings →')}
    `),
  };
}

export function domainFailedEmail(domain: string, reason: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `Action required: ${domain} verification failed`,
    html: layout('Domain verification failed', `
      ${greeting(firstName)}
      ${h1(`${domain} couldn't be verified.`)}
      ${ALERT('red', `Verification failed: <strong>${reason}</strong>. Check your DNS records and try again.`)}
      ${ROW('Domain', domain)}
      ${ROW('Reason', reason)}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/domains', 'Check DNS Records →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">DNS changes can take up to 48 hours to propagate. Reply if you need help.</span>')}
    `),
  };
}

// ─── Deliverability alerts ────────────────────────────────────────────────────────

export function highBounceRateEmail(bounceRate: number, domain: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `High bounce rate detected on ${domain}`,
    html: layout('High bounce rate alert', `
      ${greeting(firstName)}
      ${h1('High bounce rate detected.')}
      ${ALERT('red', `Your bounce rate on <strong>${domain}</strong> has reached <strong>${bounceRate.toFixed(1)}%</strong>. Rates above 5% risk SES suspension. Clean your list immediately.`)}
      ${ROW('Domain', domain)}
      ${ROW('Bounce rate', `${bounceRate.toFixed(1)}%`)}
      ${ROW('Safe threshold', '< 5%')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/analytics', 'View Analytics →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Use the verification API to clean your list before your next send.</span>')}
    `),
  };
}

export function highComplaintRateEmail(complaintRate: number, domain: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `Spam complaint rate alert on ${domain}`,
    html: layout('High complaint rate alert', `
      ${greeting(firstName)}
      ${h1('Spam complaints are elevated.')}
      ${ALERT('red', `Your complaint rate on <strong>${domain}</strong> is <strong>${complaintRate.toFixed(2)}%</strong>. Rates above 0.1% risk deliverability damage. Review your sending immediately.`)}
      ${ROW('Domain', domain)}
      ${ROW('Complaint rate', `${complaintRate.toFixed(2)}%`)}
      ${ROW('Safe threshold', '< 0.1%')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/analytics', 'View Sending Analytics →')}
    `),
  };
}

// ─── Campaigns ───────────────────────────────────────────────────────────────────

export function campaignCompletedEmail(opts: {
  campaignName: string; sent: number; delivered: number;
  opened: number; bounced: number; firstName?: string | null;
}): { subject: string; html: string } {
  const deliveryRate = opts.sent > 0 ? ((opts.delivered / opts.sent) * 100).toFixed(1) : '0';
  const openRate     = opts.delivered > 0 ? ((opts.opened / opts.delivered) * 100).toFixed(1) : '0';
  return {
    subject: `Campaign "${opts.campaignName}" sent`,
    html: layout('Campaign sent', `
      ${greeting(opts.firstName)}
      ${h1(`"${opts.campaignName}" is done.`)}
      ${ROW('Sent', opts.sent.toLocaleString())}
      ${ROW('Delivered', `${opts.delivered.toLocaleString()} (${deliveryRate}%)`)}
      ${ROW('Opened', `${opts.opened.toLocaleString()} (${openRate}%)`)}
      ${ROW('Bounced', opts.bounced.toLocaleString())}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/campaigns', 'View Full Report →')}
    `),
  };
}

// ─── Re-engagement & inactivity ──────────────────────────────────────────────────

export function inactiveUserEmail(daysSinceLastCall: number, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Still there? Your API key is waiting',
    html: layout('We miss you', `
      ${greeting(firstName)}
      ${h1('You haven\'t made an API call in a while.')}
      ${p(`It's been <strong>${daysSinceLastCall} days</strong> since your last request. Your key is still active and your quota is waiting — just need a reason to come back?`)}
      ${p('Here\'s what\'s new since you last logged in:')}
      <ul style="padding-left:18px;margin:0 0 20px">
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:4px 0">Mailing lists & campaigns</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:4px 0">Cold outreach sequences with reply detection</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:4px 0">Multi-mailbox rotation & warmup</li>
      </ul>
      ${BTN('https://app.continuumapi.com/dashboard', 'Back to Dashboard →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">If you no longer need your account, you can <a href="https://app.continuumapi.com/dashboard/settings" style="color:#9CA3AF">delete it here</a>.</span>')}
    `),
  };
}

// ─── Bulk jobs ────────────────────────────────────────────────────────────────────

export function bulkJobCompletedEmail(opts: { jobId: string; total: number; valid: number; invalid: number; risky: number; firstName?: string | null }): { subject: string; html: string } {
  return {
    subject: `Bulk verification job complete — ${opts.valid.toLocaleString()} valid`,
    html: layout('Bulk job complete', `
      ${greeting(opts.firstName)}
      ${h1('Your bulk verification job is done.')}
      ${ROW('Job ID', CODE(opts.jobId.slice(0, 16) + '…'))}
      ${ROW('Total processed', opts.total.toLocaleString())}
      ${ROW('Valid', `<strong style="color:#16A34A">${opts.valid.toLocaleString()}</strong>`)}
      ${ROW('Invalid', opts.invalid.toLocaleString())}
      ${ROW('Risky / unknown', opts.risky.toLocaleString())}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/bulk', 'Download Results →')}
    `),
  };
}

export function bulkJobFailedEmail(jobId: string, reason: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Bulk verification job failed',
    html: layout('Bulk job failed', `
      ${greeting(firstName)}
      ${h1('Your bulk job encountered an error.')}
      ${ALERT('red', `Job failed: <strong>${reason}</strong>. Any rows processed before the failure are saved.`)}
      ${ROW('Job ID', CODE(jobId.slice(0, 16) + '…'))}
      ${ROW('Reason', reason)}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/bulk', 'View Job →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Reply to this email if you need help recovering results.</span>')}
    `),
  };
}

// ─── Webhooks & monitors ──────────────────────────────────────────────────────────

export function webhookFailingEmail(endpoint: string, failCount: number, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `Webhook endpoint failing — ${failCount} consecutive errors`,
    html: layout('Webhook failures detected', `
      ${greeting(firstName)}
      ${h1('Your webhook endpoint is failing.')}
      ${ALERT('red', `<strong>${failCount} consecutive delivery attempts</strong> to your endpoint have failed. Events are being queued but will be dropped after 72 hours.`)}
      ${ROW('Endpoint', `<code style="font-family:monospace;font-size:12px;word-break:break-all">${endpoint}</code>`)}
      ${ROW('Failures', failCount.toString())}
      ${ROW('Queue expires', '72 hours from first failure')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/webhooks', 'Check Webhook Settings →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Ensure your endpoint returns a 2xx status within 10 seconds. We retry with exponential backoff.</span>')}
    `),
  };
}

export function monitorAlertEmail(opts: { monitorEmail: string; status: 'valid' | 'invalid' | 'risky'; previousStatus: string; firstName?: string | null }): { subject: string; html: string } {
  const color = opts.status === 'valid' ? 'green' : opts.status === 'risky' ? 'warning' : 'red';
  const statusLabel = { valid: '✓ Valid', invalid: '✗ Invalid', risky: '⚠ Risky' }[opts.status];
  return {
    subject: `Monitor alert: ${opts.monitorEmail} is now ${opts.status}`,
    html: layout('Email monitor alert', `
      ${greeting(opts.firstName)}
      ${h1(`${opts.monitorEmail} status changed.`)}
      ${ALERT(color, `This address is now <strong>${statusLabel}</strong> (was: ${opts.previousStatus}).`)}
      ${ROW('Address', opts.monitorEmail)}
      ${ROW('Previous status', opts.previousStatus)}
      ${ROW('Current status', statusLabel)}
      ${ROW('Checked at', new Date().toUTCString())}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/monitoring', 'View Monitor →')}
    `),
  };
}

// ─── Weekly digest ────────────────────────────────────────────────────────────────

export function weeklyDigestEmail(opts: {
  sent: number; verified: number; deliveryRate: number;
  openRate: number; used: number; limit: number;
  weekLabel: string; firstName?: string | null;
}): { subject: string; html: string } {
  const usedPct = Math.round((opts.used / opts.limit) * 100);
  return {
    subject: `Your Continuum API week: ${opts.weekLabel}`,
    html: layout('Weekly digest', `
      ${greeting(opts.firstName)}
      ${h1('Here\'s your week.')}
      ${ROW('Emails verified', opts.verified.toLocaleString())}
      ${ROW('Emails sent', opts.sent.toLocaleString())}
      ${ROW('Delivery rate', `<strong style="color:${opts.deliveryRate >= 95 ? '#16A34A' : '#374151'}">${opts.deliveryRate.toFixed(1)}%</strong>`)}
      ${ROW('Open rate', `${opts.openRate.toFixed(1)}%`)}
      ${DIVIDER}
      ${ROW('Monthly quota used', `${opts.used.toLocaleString()} / ${opts.limit.toLocaleString()}`)}
      <div style="background:#F3F4F6;border-radius:4px;height:6px;margin:8px 0 20px;overflow:hidden">
        <div style="background:#000;width:${Math.min(usedPct, 100)}%;height:100%;border-radius:4px"></div>
      </div>
      ${BTN('https://app.continuumapi.com/dashboard/analytics', 'View Full Analytics →')}
    `),
  };
}

// ─── Lifecycle / success-manager emails ──────────────────────────────────────────

export function day1ActivationEmail(keyPrefix: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Have you made your first API call yet?',
    html: layout('First API call', `
      ${greeting(firstName)}
      ${h1('Just one call away.')}
      ${p('I noticed you haven\'t made your first API call yet. That\'s fine — took me a minute to remember where I put mine too.')}
      ${p('Here\'s the quickest path to a result. Copy this, replace the email, hit send:')}
      <pre style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;padding:14px;font-family:monospace;font-size:12px;color:#374151;margin:0 0 20px;overflow-x:auto">curl -X POST https://api.continuumapi.com/v1/verify \\
  -H "X-API-Key: ${keyPrefix}..." \\
  -H "Content-Type: application/json" \\
  -d '{"email":"test@example.com"}'</pre>
      ${p('Takes about 300ms. Returns whether the address is real, the MX records, and whether it\'s a disposable or role account.')}
      ${BTN('https://app.continuumapi.com/dashboard', 'Open Dashboard →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">Hit reply if anything\'s confusing — I read these.</span>')}
    `),
  };
}

export function day3DiscoveryEmail(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Three things most people miss in week one',
    html: layout('Week one tips', `
      ${greeting(firstName)}
      ${h1('Three things worth knowing.')}
      ${p('Most developers start with verification (makes sense — it\'s what the name says). But there are three other things that are worth five minutes now:')}
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px">
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #F3F4F6;vertical-align:top;width:28px">
            <span style="font-family:monospace;font-size:11px;color:#9CA3AF;font-weight:600">01</span>
          </td>
          <td style="padding:14px 0 14px 14px;border-bottom:1px solid #F3F4F6">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 4px">Bulk verification via CSV</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Upload a list, we process it asynchronously, you download the results. Works up to 10 million rows.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #F3F4F6;vertical-align:top;width:28px">
            <span style="font-family:monospace;font-size:11px;color:#9CA3AF;font-weight:600">02</span>
          </td>
          <td style="padding:14px 0 14px 14px;border-bottom:1px solid #F3F4F6">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 4px">Transactional email sending</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Same API key, same endpoint pattern. POST to /v1/send — no separate tool, no second bill.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 0;vertical-align:top;width:28px">
            <span style="font-family:monospace;font-size:11px;color:#9CA3AF;font-weight:600">03</span>
          </td>
          <td style="padding:14px 0 14px 14px">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 4px">Email monitors</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Track any address over time. We alert you when status changes — useful for key accounts or customer emails where deliverability matters.</p>
          </td>
        </tr>
      </table>
      ${BTN('https://app.continuumapi.com/dashboard', 'Explore the Dashboard →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">Questions? Reply here — I check these daily.</span>')}
    `),
  };
}

export function day7CheckInEmail(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Quick check-in — how\'s Continuum working for you?',
    html: layout('Week one check-in', `
      ${greeting(firstName)}
      ${h1('How\'s it going?')}
      ${p('You\'ve been with us for a week and I wanted to reach out personally.')}
      ${p('Most teams use Continuum to solve one of three things:')}
      <ul style="padding-left:18px;margin:0 0 20px">
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>List hygiene</strong> — cleaning a database before a big send</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>Signup validation</strong> — blocking invalid emails at the form level</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>Full email stack</strong> — replacing Sendgrid + Mailchimp + Smartlead in one go</li>
      </ul>
      ${p('Which one are you trying to solve? Or is it something else entirely?')}
      ${p('Hit reply and tell me — I\'ll point you to the fastest path, and if something isn\'t working the way you expected, I\'d rather know now than later.')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet, founder @ Continuum API<br>You can reply directly to this email.</span>')}
    `),
  };
}

export function day14ValueEmail(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Two weeks in — what teams are actually building',
    html: layout('Two weeks in', `
      ${greeting(firstName)}
      ${h1('What people are building with Continuum.')}
      ${p('You\'re two weeks in. Here\'s what other teams have shipped in their first month:')}
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;border:1px solid #E5E7EB;border-radius:6px;overflow:hidden">
        <tr style="background:#F9FAFB">
          <td style="padding:14px 16px;border-bottom:1px solid #E5E7EB">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">SaaS startup — signup validation</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Added real-time verification to their signup form. Invalid email rate dropped from 12% to 0.4% in 48 hours.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #E5E7EB">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">Agency — cold outreach</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Replaced Instantly + MillionVerifier with one API key. Saved $380/month and simplified their stack to a single dashboard.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">Developer tools company — transactional email</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Migrated from Sendgrid. Kept the same API pattern, got verification + sending + analytics in one place.</p>
          </td>
        </tr>
      </table>
      ${p('If any of these look like where you\'re headed, or if you\'re still figuring out the right fit — reply and I\'ll help you map it out.')}
      ${BTN('https://app.continuumapi.com/dashboard', 'Check Your Dashboard →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet @ Continuum API<br>Reply directly to this email — I\'m reachable.</span>')}
    `),
  };
}

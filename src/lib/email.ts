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

const FROM = `Continuum <${config.SUPPORT_EMAIL ?? 'noreply@continuumapi.com'}>`;

export async function sendEmail(
  toOrOpts: string | { to: string; subject: string; html: string },
  subjectArg?: string,
  htmlArg?: string,
): Promise<boolean> {
  const to      = typeof toOrOpts === 'string' ? toOrOpts           : toOrOpts.to;
  const subject = typeof toOrOpts === 'string' ? (subjectArg ?? '') : toOrOpts.subject;
  const html    = typeof toOrOpts === 'string' ? (htmlArg ?? '')    : toOrOpts.html;
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

// The real mark (src/components/Logo.tsx, Mark()) — black rounded square,
// white dashed-circle ring. Static here: email clients don't render the
// site's CSS spin animation, and a still ring reads fine at rest.
const LOGO = `<table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:0">
  <tr>
    <td style="background:#000;padding:20px 32px;border-radius:4px 4px 0 0">
      <table cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-right:10px;vertical-align:middle">
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block">
              <rect width="32" height="32" rx="8" fill="#000"/>
              <circle cx="16" cy="16" r="9.5" stroke="#fff" stroke-width="2.8" stroke-dasharray="9 3" stroke-linecap="round"/>
            </svg>
          </td>
          <td style="vertical-align:middle">
            <span style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#fff">Continuum</span>
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
        © 2026 Continuum &nbsp;·&nbsp;
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
      ${BTN('https://app.continuumapi.com/dashboard', 'Open Dashboard →')}
      ${DIVIDER}
      ${ROW('API endpoint', '<code style="font-family:monospace;font-size:12px">api.continuumapi.com</code>')}
      ${ROW('Monthly verifications', '500 (free)')}
      ${ROW('Docs', '<a href="https://continuumapi.com/docs" style="color:#374151">continuumapi.com/docs</a>')}
    `),
  };
}

export function loginAlertEmail(opts: { browser: string; location: string; ip: string; time: string; firstName?: string | null }): { subject: string; html: string } {
  return {
    subject: 'New sign-in to your Continuum account',
    html: layout('New sign-in detected', `
      ${greeting(opts.firstName)}
      ${h1('New sign-in to your account.')}
      ${p('We detected a sign-in to your Continuum account from a new session.')}
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
    subject: 'Your Continuum plan has changed',
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

export function mailboxReconnectEmail(username: string, reason: string, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: `Action required: reconnect ${username}`,
    html: layout('Mailbox needs reconnecting', `
      ${greeting(firstName)}
      ${h1(`${username} needs to be reconnected.`)}
      ${ALERT('red', `${reason} Sequences and warmup using this mailbox are paused until it's reconnected.`)}
      ${ROW('Mailbox', username)}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/mailboxes', 'Reconnect Mailbox →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Re-enter your credentials on the Mailboxes page — no other settings are affected.</span>')}
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
    subject: `Your Continuum week: ${opts.weekLabel}`,
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
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet<br>You can reply directly to this email.</span>')}
    `),
  };
}

export function day14ValueEmail(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Two weeks in — three combinations worth trying',
    html: layout('Two weeks in', `
      ${greeting(firstName)}
      ${h1('The features that compound.')}
      ${p('You\'re two weeks in. Most of the value in Continuum shows up when two agents work together, not from any single one. Three combinations worth trying this week:')}
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;border:1px solid #E5E7EB;border-radius:6px;overflow:hidden">
        <tr style="background:#F9FAFB">
          <td style="padding:14px 16px;border-bottom:1px solid #E5E7EB">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">Verify Agent + Transactional</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Add <code>verify_before_send: true</code> to any <code>/v1/send</code> call — invalid addresses get rejected before they ever touch your SES reputation, in the same request.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #E5E7EB">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">Finder Agent + Outbound Agent</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Import search results straight into a sequence — no CSV export, no re-upload. Leads go from "found" to "enrolled" in one API call.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 16px">
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#0A0A0A;margin:0 0 3px">Verify Agent + Monitors</p>
            <p style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#6B7280;margin:0">Put a monitor on any address that matters (a key account, a high-value lead) — a webhook fires the instant its status changes, instead of you finding out from a bounce.</p>
          </td>
        </tr>
      </table>
      ${p('If you\'re not sure which of these fits what you\'re building — reply and tell me, and I\'ll point you at the fastest path.')}
      ${BTN('https://app.continuumapi.com/dashboard', 'Check Your Dashboard →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet<br>Reply directly to this email.</span>')}
    `),
  };
}

export function day21Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'One five-minute setup most people skip',
    html: layout('Custom sending domain', `
      ${greeting(firstName)}
      ${h1('Sending from your own domain takes five minutes.')}
      ${p('If you\'re still sending transactional mail from a shared or default address, this is worth doing now rather than later — it\'s the single biggest lever on inbox placement, and it only gets more annoying to set up once you\'re sending real volume.')}
      ${ROW('Add a domain', CODE('POST /v1/domains'))}
      ${ROW('What you get back', 'DKIM keypair + exact DNS records to add')}
      ${ROW('Propagation', 'Usually minutes, up to 48h worst case')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/domains', 'Add Your Domain →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Stuck on DNS? Reply with your registrar and I\'ll tell you exactly what to paste where.<br>— Sumeet</span>')}
    `),
  };
}

export function day30Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'One month in — what\'s actually in each plan',
    html: layout('One month in', `
      ${greeting(firstName)}
      ${h1('A month in. Here\'s the honest plan breakdown.')}
      ${p('No pitch here — just what each tier actually unlocks, since the pricing page compresses it more than it should:')}
      <ul style="padding-left:18px;margin:0 0 20px">
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>Free</strong> — full verification + transactional + nurture, 1k/mo, 1 mailbox. No time limit, no trial clock.</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>Starter ($29)</strong> — adds cold outbound sequences, the Finder agent, and inbox warmup. This is the tier where the other four agents stop being locked.</li>
        <li style="font-family:Inter,-apple-system,sans-serif;font-size:13px;color:#374151;padding:5px 0"><strong>Growth ($79)</strong> — adds AI sequence generation, AI personalization, and inbox placement testing.</li>
      </ul>
      ${p('If you\'re on Free and hitting the verification or send limit regularly, that\'s the actual signal to upgrade — not a countdown timer.')}
      ${BTN('https://app.continuumapi.com/dashboard/billing', 'Compare Plans →')}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">Questions about what fits your usage? Reply and I\'ll look at your actual numbers.<br>— Sumeet</span>')}
    `),
  };
}

export function day45Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'The agent most people forget they have',
    html: layout('Nurture Agent', `
      ${greeting(firstName)}
      ${h1('Nurture Agent — the one people forget they already have.')}
      ${p('If you signed up for verification or transactional sending, there\'s a decent chance you never opened the Nurture tab. I notice this a lot — it\'s the same API key, same contact model, and it\'s already running:')}
      ${ROW('Lists & segments', 'Filter contacts by field, subscription date, or open behaviour')}
      ${ROW('Drip automations', CODE('POST /v1/automations/trigger') + ' from your app')}
      ${ROW('Compliance', 'One-click unsubscribe + double opt-in, handled automatically')}
      ${DIVIDER}
      ${p('If you already have a contacts table somewhere, this is usually a same-day migration, not a project — reply if you want help mapping the fields.')}
      ${BTN('https://app.continuumapi.com/dashboard/nurture-agent', 'Open Nurture Agent →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet</span>')}
    `),
  };
}

export function day60Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Finding leads without leaving your sequence tool',
    html: layout('Finder Agent', `
      ${greeting(firstName)}
      ${h1('Finder Agent — search, then enroll, in one call.')}
      ${p('Most people run lead search in one tool, export a CSV, then re-upload it into whatever sends the sequence. I built Finder Agent to skip the middle step — search results enroll directly:')}
      ${ROW('Search', CODE('POST /v1/finder/search') + ' by title, industry, geography')}
      ${ROW('Import', 'Straight into a sequence — no CSV round-trip')}
      ${ROW('Enrichment', 'An icebreaker generated per lead at import')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/finder-agent', 'Try Finder Agent →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Already using Clay or Apollo? Finder Agent has webhook intake for both — bring your existing enrichment, skip re-verifying.<br>— Sumeet</span>')}
    `),
  };
}

export function day75Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Before you run your first cold sequence — warm up the mailbox',
    html: layout('Warmup Agent', `
      ${greeting(firstName)}
      ${h1('A brand-new mailbox sending 200 cold emails on day one gets flagged.')}
      ${p('If Outbound Agent is on your list to try, Warmup Agent is the thing to run first — not after. It ramps a connected mailbox gradually so its reputation is built before your sequences actually need it:')}
      ${ROW('Day 1', '5 emails/day')}
      ${ROW('Day 7', '12 emails/day')}
      ${ROW('Day 30', '40 emails/day, full reputation')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard/warmup-agent', 'Start Warmup →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">Already sending cold outbound from an unwarmed mailbox? Start this in parallel — it won\'t undo damage already done, but it stops it from getting worse.<br>— Sumeet</span>')}
    `),
  };
}

export function day90Email(firstName?: string | null): { subject: string; html: string } {
  return {
    subject: 'Three months — one honest question',
    html: layout('Three months in', `
      ${greeting(firstName)}
      ${h1('You\'ve been here three months.')}
      ${p('No feature pitch this time — just one real question: what\'s the thing about Continuum that\'s still annoying, missing, or confusing? Reply and tell me. I read every one of these, and the roadmap is built from exactly this kind of message, not guesswork.')}
      ${p('And if it\'s been genuinely useful — the fastest way to help is a two-line honest review or a referral. I\'m early enough that either one actually moves things.')}
      ${DIVIDER}
      ${BTN('https://app.continuumapi.com/dashboard', 'Open Dashboard →')}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet</span>')}
    `),
  };
}

// ─── Feature spotlights ────────────────────────────────────────────────────────
// One real feature per email, not one email per day of filler. Days start at
// 17 (after the day-14 value email) and step every 5 days, so a signup who
// stays subscribed sees the full 37 over roughly six months. Wired in
// emailSweep.ts by day-since-creation, same mechanism as the day-N emails.

export interface FeatureSpotlight {
  tag: string;
  agent: string;
  headline: string;
  body: string;
  cta: { href: string; label: string };
}

export const FEATURE_SPOTLIGHTS: FeatureSpotlight[] = [
  // ── Verify Agent (12 checks) ──
  { tag: 'verify-syntax', agent: 'Verify Agent', headline: 'The check that runs before any network call.', body: 'RFC-compliant syntax validation catches a malformed address in under a millisecond — before Verify Agent ever spends a DNS lookup or an SMTP handshake on it. Cheap filters first is the whole design.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-mx', agent: 'Verify Agent', headline: 'MX check: does the domain even accept mail?', body: 'Live DNS resolution against the domain\'s MX records — not a cached list. A domain with no mail server configured fails here, instantly, before anything more expensive runs.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-smtp', agent: 'Verify Agent', headline: 'SMTP probing — checking the specific mailbox, not just the domain.', body: 'A mailbox-level handshake confirms the exact address exists on that mail server, not just that the domain accepts mail generically. This is the check that catches typos in the local part.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-catchall', agent: 'Verify Agent', headline: 'Catch-all detection — the check most verifiers skip.', body: 'Some domains accept mail to any address regardless of whether it exists, which makes SMTP probing lie to you. Verify Agent flags catch-all domains explicitly instead of reporting a false "valid."', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-disposable', agent: 'Verify Agent', headline: 'Blocking throwaway addresses at signup.', body: 'Mailinator, Guerrilla Mail, and every other disposable provider get flagged automatically — useful the moment you plug verification into a signup form and want real users, not one-time inboxes.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-role', agent: 'Verify Agent', headline: 'Role accounts: technically valid, usually low-value.', body: 'info@, support@, noreply@ — these addresses exist and accept mail, but they\'re shared inboxes, not people. Role-account detection lets you treat them differently in your funnel instead of scoring them the same as a real signup.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-greylist', agent: 'Verify Agent', headline: 'Handling greylisting without a false negative.', body: 'Some mail servers temporarily defer unfamiliar senders as an anti-spam tactic. Verify Agent recognizes a greylist response for what it is instead of reporting the address as invalid.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-auth', agent: 'Verify Agent', headline: 'SPF, DKIM, DMARC — checking the domain\'s own setup.', body: 'Beyond whether an address exists, Verify Agent checks whether the sending domain\'s auth records are configured correctly. A misconfigured domain is often the real reason mail bounces, not the address itself.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-blacklist', agent: 'Verify Agent', headline: 'Cross-checking domain blacklists in real time.', body: 'Spamhaus, Barracuda, and other blacklists get checked on every verification — so you find out a domain has a reputation problem before you send to it, not after your own domain gets tainted.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-spoof', agent: 'Verify Agent', headline: 'Catching look-alike domains before they catch you.', body: 'Subdomain spoofing and typosquat detection flags addresses on domains built to look like a real one — the same pattern used in phishing. Worth knowing about before that address ends up in your CRM.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-score', agent: 'Verify Agent', headline: 'A 0–100 score, not just valid/invalid.', body: 'Deliverability isn\'t always binary. The score lets you act on a threshold that fits your risk tolerance instead of a hard yes/no — useful when "risky" addresses are still worth sending to.', cta: { href: 'https://app.continuumapi.com/dashboard/verify-agent', label: 'Open Verify Agent →' } },
  { tag: 'verify-monitor', agent: 'Verify Agent', headline: 'An address can go bad after you\'ve already verified it.', body: 'Continuous monitoring re-checks addresses on a schedule and fires a webhook the moment a status changes — so a key account\'s email going stale shows up as a notification, not a bounce.', cta: { href: 'https://app.continuumapi.com/dashboard/monitoring', label: 'Set Up a Monitor →' } },

  // ── Transactional (6) ──
  { tag: 'send-templates', agent: 'Transactional', headline: 'Templates with real logic, not just find-and-replace.', body: 'HTML or MJML templates support curly-brace variables, spintax, and Liquid conditionals, compiled server-side — the same template can branch on who it\'s going to, not just fill in a name.', cta: { href: 'https://app.continuumapi.com/dashboard/templates', label: 'Manage Templates →' } },
  { tag: 'send-batch', agent: 'Transactional', headline: 'Batch sending, with per-message suppression built in.', body: 'POST /v1/send/batch takes up to 100 messages in one call, and every single one is checked against your suppression list before it ships — batching doesn\'t bypass compliance.', cta: { href: 'https://app.continuumapi.com/dashboard/batch-send', label: 'Try Batch Send →' } },
  { tag: 'send-schedule', agent: 'Transactional', headline: 'Scheduled delivery you can still cancel.', body: 'Set scheduled_at and the message queues via BullMQ. Change your mind any time before it fires — cancellation isn\'t a race condition against a cron job.', cta: { href: 'https://app.continuumapi.com/dashboard/schedule', label: 'View Scheduled Sends →' } },
  { tag: 'send-tracking', agent: 'Transactional', headline: 'Open and click tracking, injected automatically.', body: 'A 1×1 pixel and wrapped links get added without any change to your template, and every event lands in /v1/analytics — you don\'t have to remember to instrument each send.', cta: { href: 'https://app.continuumapi.com/dashboard/analytics', label: 'View Analytics →' } },
  { tag: 'send-domains', agent: 'Transactional', headline: 'Custom sending domains, DKIM handled for you.', body: 'Add a domain and Continuum generates the DKIM keypair and hands you the exact DNS records to paste. No manual key generation, no guessing at record format.', cta: { href: 'https://app.continuumapi.com/dashboard/domains', label: 'Add a Sending Domain →' } },
  { tag: 'send-verify', agent: 'Transactional', headline: 'The one flag that prevents most reputation damage.', body: 'verify_before_send: true on any /v1/send call aborts delivery to an invalid address before it ever reaches SES. This alone is usually the highest-leverage thing to turn on.', cta: { href: 'https://app.continuumapi.com/dashboard/transactional', label: 'Open Transactional →' } },

  // ── Nurture Agent (6) ──
  { tag: 'nurture-segments', agent: 'Nurture Agent', headline: 'Segments built on real signals, not just tags.', body: 'Filter contacts by field values, subscription date, or open behaviour — a segment can be "opened 2 of the last 3 sends" as easily as "tagged VIP."', cta: { href: 'https://app.continuumapi.com/dashboard/segments', label: 'Build a Segment →' } },
  { tag: 'nurture-campaigns', agent: 'Nurture Agent', headline: 'Campaigns with A/B subject testing built in.', body: 'One-time or scheduled broadcasts support subject-line testing and spintax out of the box — you don\'t need a separate tool to find out which subject line actually gets opened.', cta: { href: 'https://app.continuumapi.com/dashboard/campaigns', label: 'Create a Campaign →' } },
  { tag: 'nurture-triggers', agent: 'Nurture Agent', headline: 'Drips that start from your app, not a schedule.', body: 'POST /v1/automations/trigger from anywhere in your codebase and a contact enters a timed, multi-step drip automatically — trial expiring, cart abandoned, whatever your app already knows.', cta: { href: 'https://app.continuumapi.com/dashboard/automations', label: 'Set Up an Automation →' } },
  { tag: 'nurture-unsub', agent: 'Nurture Agent', headline: 'One-click unsubscribe, RFC 8058 compliant.', body: 'The List-Unsubscribe header gets injected on every send automatically — this is what keeps Gmail from routing your nurture sends straight to spam for lacking it.', cta: { href: 'https://app.continuumapi.com/dashboard/lists', label: 'View Mailing Lists →' } },
  { tag: 'nurture-optin', agent: 'Nurture Agent', headline: 'Double opt-in, without you building the confirmation flow.', body: 'Continuum sends the confirmation email and handles the state — GDPR-ready consent without you writing a single line of that logic yourself.', cta: { href: 'https://app.continuumapi.com/dashboard/lists', label: 'View Mailing Lists →' } },
  { tag: 'nurture-suppress', agent: 'Nurture Agent', headline: 'The suppression list gets checked on every single step.', body: 'Not just once at signup — every recipient is re-checked against the global suppression list before each step of a campaign fires. An unsubscribe mid-sequence actually stops the sequence.', cta: { href: 'https://app.continuumapi.com/dashboard/suppressions', label: 'View Suppressions →' } },

  // ── Outbound Agent (8) ──
  { tag: 'outbound-ai-seq', agent: 'Outbound Agent', headline: 'A full sequence from one sentence.', body: 'Describe your ICP and goal, and AI sequence generation returns email copy, LinkedIn steps, and task notes as a complete plan — a starting point in seconds, not a blank page.', cta: { href: 'https://app.continuumapi.com/dashboard/sequences', label: 'Generate a Sequence →' } },
  { tag: 'outbound-rotation', agent: 'Outbound Agent', headline: 'Multi-mailbox rotation for reputation spread.', body: 'Connect SMTP, Gmail, or Outlook and Continuum rotates sends per-recipient across them — spreading volume and daily limits instead of hammering one mailbox\'s reputation.', cta: { href: 'https://app.continuumapi.com/dashboard/mailboxes', label: 'Connect a Mailbox →' } },
  { tag: 'outbound-warmup', agent: 'Outbound Agent', headline: 'Warmup isn\'t optional if the mailbox is new.', body: 'A fresh mailbox ramps from 5 to 40 emails/day over 30 days before it\'s trusted with real cold volume — the agent that runs quietly in the background before Outbound needs it.', cta: { href: 'https://app.continuumapi.com/dashboard/warmup-agent', label: 'Start Warmup →' } },
  { tag: 'outbound-firstline', agent: 'Outbound Agent', headline: 'A real first line, not a merge tag.', body: 'AI writes a personalized opener per lead at enrollment, using their company, title, and context — the difference between "Hi {{first_name}}" and something that reads like it was actually written for them.', cta: { href: 'https://app.continuumapi.com/dashboard/sequences', label: 'Open Sequences →' } },
  { tag: 'outbound-reply', agent: 'Outbound Agent', headline: 'Reply detection that actually stops the sequence.', body: 'A worker polls connected mailboxes every 15 minutes — a real reply pauses or stops enrollment automatically. Nobody keeps getting follow-up 3 after they\'ve already responded.', cta: { href: 'https://app.continuumapi.com/dashboard/inbox', label: 'View Unified Inbox →' } },
  { tag: 'outbound-classify', agent: 'Outbound Agent', headline: 'Replies get classified, not just detected.', body: 'Interested, meeting request, out-of-office, unsubscribe — each incoming reply gets auto-classified with a suggested next action, so triage isn\'t a manual read-through of every response.', cta: { href: 'https://app.continuumapi.com/dashboard/inbox', label: 'View Unified Inbox →' } },
  { tag: 'outbound-conditional', agent: 'Outbound Agent', headline: 'Steps that skip themselves when they\'re not needed.', body: 'if_not_opened and if_not_replied conditions mean a follow-up doesn\'t fire on someone who already engaged — no manual review of who to skip.', cta: { href: 'https://app.continuumapi.com/dashboard/sequences', label: 'Open Sequences →' } },
  { tag: 'outbound-unified', agent: 'Outbound Agent', headline: 'Every reply, every mailbox, one inbox.', body: 'Replies across every connected mailbox land in one view, with the sequence and enrollment context attached — no switching between five Gmail tabs to see what came in.', cta: { href: 'https://app.continuumapi.com/dashboard/inbox', label: 'View Unified Inbox →' } },

  // ── Finder Agent (5) ──
  { tag: 'finder-search', agent: 'Finder Agent', headline: 'Search on the filters that actually narrow a list.', body: 'Title, seniority, company size, industry, geography — ICP-based search filters on the parameters that matter, not just a keyword match on a job title string.', cta: { href: 'https://app.continuumapi.com/dashboard/finder', label: 'Search for Leads →' } },
  { tag: 'finder-enroll', agent: 'Finder Agent', headline: 'From search result to enrolled lead, no CSV.', body: 'Import search results directly into a sequence — the CSV export/re-upload step that eats most of an afternoon in other tools just doesn\'t exist here.', cta: { href: 'https://app.continuumapi.com/dashboard/finder', label: 'Search for Leads →' } },
  { tag: 'finder-enrich', agent: 'Finder Agent', headline: 'An icebreaker generated at the moment of import.', body: 'AI lead enrichment surfaces pain points and relevant context per lead, and generates an opening line — before the lead even enters a sequence.', cta: { href: 'https://app.continuumapi.com/dashboard/finder', label: 'Search for Leads →' } },
  { tag: 'finder-crm', agent: 'Finder Agent', headline: 'A CRM with the full activity timeline attached.', body: 'Every send, open, click, and reply against a lead is logged in one place — engagement history without exporting anything into a spreadsheet to piece it together.', cta: { href: 'https://app.continuumapi.com/dashboard/leads', label: 'Open Lead CRM →' } },
  { tag: 'finder-connectors', agent: 'Finder Agent', headline: 'Already paying for Clay or Apollo? Bring them along.', body: 'Webhook intake for Clay HTTP enrichment and Apollo exports, plus a generic field-mapper for Zapier, Make, and n8n — Finder Agent doesn\'t require you to abandon an existing enrichment setup.', cta: { href: 'https://app.continuumapi.com/dashboard/connectors', label: 'View Connectors →' } },
];

export function featureSpotlightEmail(s: FeatureSpotlight, firstName?: string | null): { subject: string; html: string } {
  return {
    subject: s.headline,
    html: layout(s.headline, `
      ${greeting(firstName)}
      <div class="mono" style="font-family:monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#9CA3AF;margin:0 0 8px">${s.agent}</div>
      ${h1(s.headline)}
      ${p(s.body)}
      ${BTN(s.cta.href, s.cta.label)}
      ${DIVIDER}
      ${p('<span style="color:#9CA3AF;font-size:12px">— Sumeet</span>')}
    `),
  };
}

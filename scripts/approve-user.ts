/**
 * Continuum API — Approve a waitlist user
 *
 * Usage:
 *   npx tsx scripts/approve-user.ts --email user@example.com --label "Beta user"
 *
 * What it does:
 *   1. Generates a new cnt_xxx API key
 *   2. Inserts it into Supabase (api_keys table)
 *   3. Emails the key to the user via Resend
 *   4. Emails you a confirmation at sumeet@continuumapi.com
 */

import crypto from 'node:crypto';

const SUPABASE_URL     = 'https://ghdkanhhfhxfbskszuqk.supabase.co';
const SUPABASE_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZGthbmhoZmh4ZmJza3N6dXFrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzA4NDU5MSwiZXhwIjoyMDkyNjYwNTkxfQ.Oh6PBVuj6uToTYepGWRc8GvXofafWZ97DuQLAPCHiws';
const API_KEY_SALT     = '7f3a9b2c1d8e4f6a0b5c7d9e2f4a8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f';
const RESEND_API_KEY   = process.env['RESEND_API_KEY'] ?? '';
const FROM_EMAIL       = 'Continuum API <sumeet@continuumapi.com>';
const NOTIFY_EMAIL     = 'sumeet@continuumapi.com';
const API_URL          = 'https://web-production-354247.up.railway.app';

// ─── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const email = getArg('--email');
const label = getArg('--label') ?? 'Beta user';
const rpm   = parseInt(getArg('--rpm') ?? '1000', 10);

if (!email) {
  console.error('Usage: npx tsx scripts/approve-user.ts --email user@example.com --label "Beta user"');
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.error('Set RESEND_API_KEY environment variable');
  console.error('Example: $env:RESEND_API_KEY="re_xxx"; npx tsx scripts/approve-user.ts --email ...');
  process.exit(1);
}

// ─── Generate API key ─────────────────────────────────────────────────────────

const rawKey   = 'cnt_' + crypto.randomBytes(24).toString('hex');
const keyHash  = crypto.createHash('sha256').update(API_KEY_SALT + rawKey).digest('hex');
const keyPrefix = rawKey.slice(0, 12);
const keyId    = crypto.randomBytes(8).toString('hex');

console.log('\n── Continuum API — Approve User ──────────────────');
console.log(`Email:    ${email}`);
console.log(`Label:    ${label}`);
console.log(`Key:      ${rawKey}`);
console.log(`Prefix:   ${keyPrefix}`);
console.log('──────────────────────────────────────────────────\n');

// ─── Insert into Supabase ────────────────────────────────────────────────────

console.log('1. Inserting API key into Supabase...');

const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/api_keys`, {
  method: 'POST',
  headers: {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=minimal',
  },
  body: JSON.stringify({
    id:         keyId,
    keyHash,
    keyPrefix,
    label,
    rateLimit:  rpm,
    isActive:   true,
    createdAt:  new Date().toISOString(),
  }),
});

if (!insertRes.ok) {
  const err = await insertRes.text();
  console.error('Failed to insert API key:', err);
  process.exit(1);
}
console.log('   ✓ API key saved to database\n');

// ─── Send key to user ────────────────────────────────────────────────────────

console.log('2. Sending API key to user...');

const userEmail = {
  from:    FROM_EMAIL,
  to:      [email],
  subject: 'Your Continuum API key — free beta access',
  html: `
    <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #111;">
      <div style="margin-bottom: 32px;">
        <span style="font-size: 18px; font-weight: 600; letter-spacing: -0.02em;">Continuum API</span>
        <span style="font-size: 12px; color: #888; margin-left: 8px; letter-spacing: 0.1em;">API</span>
      </div>

      <p style="font-size: 16px; line-height: 1.6;">You're approved for the Continuum API free beta.</p>

      <p style="font-size: 15px; line-height: 1.6; color: #444;">
        Full API access is free until <strong>May 17, 2026</strong>. No credit card required.
      </p>

      <div style="background: #f5f5f5; border-radius: 8px; padding: 20px 24px; margin: 28px 0;">
        <p style="font-size: 11px; color: #888; margin: 0 0 8px; letter-spacing: 0.1em; text-transform: uppercase;">Your API key</p>
        <p style="font-family: monospace; font-size: 15px; color: #111; margin: 0; word-break: break-all;">${rawKey}</p>
      </div>

      <p style="font-size: 13px; color: #888; margin: -12px 0 28px;">
        Save this key — it won't be shown again.
      </p>

      <p style="font-size: 15px; line-height: 1.6; color: #444;">Quick start:</p>

      <div style="background: #0a0a0a; border-radius: 8px; padding: 20px 24px; margin: 0 0 28px;">
        <pre style="font-family: monospace; font-size: 13px; color: #e5e5e5; margin: 0; overflow-x: auto;">curl -X POST ${API_URL}/v1/verify \\
  -H "Authorization: Bearer ${rawKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"test@example.com"}'</pre>
      </div>

      <p style="font-size: 15px; line-height: 1.6; color: #444;">
        <strong>What you get:</strong><br/>
        • 1,000 verifications/month (free beta)<br/>
        • Bulk CSV upload<br/>
        • Email monitoring<br/>
        • Signed webhooks<br/>
        • 9 verification checks per email
      </p>

      <p style="font-size: 15px; line-height: 1.6; color: #444;">
        Reply to this email if you have any questions. I read everything.
      </p>

      <p style="font-size: 15px; line-height: 1.6;">
        — Sumeet<br/>
        <span style="color: #888;">Continuum API, a SignalPulse Technologies product</span>
      </p>

      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0;"/>

      <p style="font-size: 12px; color: #aaa;">
        continuumapi.com · sumeet@continuumapi.com<br/>
        Free beta ends May 17, 2026. Paid plans start May 18.
      </p>
    </div>
  `,
};

const userRes = await fetch('https://api.resend.com/emails', {
  method:  'POST',
  headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  body:    JSON.stringify(userEmail),
});

if (!userRes.ok) {
  const err = await userRes.text();
  console.error('Failed to send user email:', err);
  process.exit(1);
}
console.log('   ✓ API key emailed to user\n');

// ─── Notify yourself ──────────────────────────────────────────────────────────

console.log('3. Sending confirmation to you...');

const notifyEmail = {
  from:    FROM_EMAIL,
  to:      [NOTIFY_EMAIL],
  subject: `✓ Approved: ${email}`,
  html: `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; padding: 24px; color: #111;">
      <p><strong>${email}</strong> has been approved and their API key has been sent.</p>
      <p style="color: #888; font-size: 13px;">Key prefix: <code>${keyPrefix}</code><br/>Label: ${label}<br/>Rate limit: ${rpm} RPM</p>
    </div>
  `,
};

const notifyRes = await fetch('https://api.resend.com/emails', {
  method:  'POST',
  headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
  body:    JSON.stringify(notifyEmail),
});

if (!notifyRes.ok) {
  console.warn('Could not send notify email (non-fatal)');
} else {
  console.log('   ✓ Confirmation sent to you\n');
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('──────────────────────────────────────────────────');
console.log(`✓ Done. ${email} is approved and has their key.`);
console.log('──────────────────────────────────────────────────\n');

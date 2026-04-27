import crypto from 'node:crypto';

const SUPABASE_URL   = 'https://ghdkanhhfhxfbskszuqk.supabase.co';
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZGthbmhoZmh4ZmJza3N6dXFrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzA4NDU5MSwiZXhwIjoyMDkyNjYwNTkxfQ.Oh6PBVuj6uToTYepGWRc8GvXofafWZ97DuQLAPCHiws';
const API_KEY_SALT   = '7f3a9b2c1d8e4f6a0b5c7d9e2f4a8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f';
const FROM_EMAIL     = 'Continuum API <sumeet@continuumapi.com>';
const NOTIFY_EMAIL   = 'sumeet@continuumapi.com';
const API_URL        = 'https://api.continuumapi.com';

const args    = process.argv.slice(2);
const getArg  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : undefined; };
const email   = getArg('--email');
const label   = getArg('--label') ?? 'Beta user';
const rpm     = parseInt(getArg('--rpm') ?? '1000', 10);
const RESEND  = process.env['RESEND_API_KEY'] ?? '';

async function main(): Promise<void> {
  if (!email) { console.error('Usage: npx tsx scripts/approve-user.ts --email x@y.com'); process.exit(1); }
  if (!RESEND) { console.error('Set RESEND_API_KEY env var'); process.exit(1); }

  const rawKey    = 'cnt_' + crypto.randomBytes(24).toString('hex');
  const keyHash   = crypto.createHash('sha256').update(API_KEY_SALT + rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 12);
  const keyId     = crypto.randomBytes(8).toString('hex');

  console.log(`\nApproving: ${email}`);
  console.log(`Key: ${rawKey}\n`);

  const r1 = await fetch(`${SUPABASE_URL}/rest/v1/api_keys`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ id: keyId, keyHash, keyPrefix, keyRaw: rawKey, label, rateLimit: rpm, isActive: true, createdAt: new Date().toISOString() }),
  });
  if (!r1.ok) { console.error('DB insert failed:', await r1.text()); process.exit(1); }
  console.log('✓ Key saved to database');

  const r2 = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [email],
      subject: 'Your Continuum API key — free beta access',
      html: `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:40px 20px;color:#111;">
        <p style="font-size:18px;font-weight:600">Continuum API</p>
        <p>You are approved for the free beta. Full access until May 17, 2026.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:24px 0">
          <p style="font-size:11px;color:#888;margin:0 0 8px;letter-spacing:.1em;text-transform:uppercase">Your API key</p>
          <p style="font-family:monospace;font-size:15px;margin:0;word-break:break-all">${rawKey}</p>
        </div>
        <p style="font-size:13px;color:#888">Save this key. It will not be shown again.</p>
        <div style="background:#0a0a0a;border-radius:8px;padding:20px;margin:24px 0">
          <pre style="font-family:monospace;font-size:13px;color:#e5e5e5;margin:0">curl -X POST ${API_URL}/v1/verify \
  -H "Authorization: Bearer ${rawKey}" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'</pre>
        </div>
        <p>Dashboard: <a href="https://app.continuumapi.com">app.continuumapi.com</a></p>
        <p>— Sumeet<br><span style="color:#888">Continuum API, a SignalPulse Technologies product</span></p>
      </div>`,
    }),
  });
  if (!r2.ok) { console.error('Email failed:', await r2.text()); process.exit(1); }
  console.log('✓ Welcome email sent to user');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [NOTIFY_EMAIL],
      subject: `Approved: ${email}`,
      html: `<p><b>${email}</b> approved. Key prefix: ${keyPrefix}</p>`,
    }),
  });
  console.log('✓ Notification sent to you');
  console.log(`\nDone. ${email} is approved.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });

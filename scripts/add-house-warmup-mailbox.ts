/**
 * Registers a real, already-created mailbox (Gmail, Outlook, or plain
 * SMTP) as a house-owned seed mailbox in the shared warmup pool — see
 * Mailbox.isHousePool in schema.prisma for why this exists: the pool is
 * cross-customer with no per-account scoping, and needs at least one
 * other active mailbox to pair with. With few real customers enrolled at
 * once, that requirement was never met and warmup silently never ran for
 * anyone. House-pool mailboxes are guaranteed partners.
 *
 * This does NOT create the mailbox account itself — you need a real
 * Gmail/Outlook/SMTP inbox already set up (an app password or OAuth
 * token in hand) before running this. It only registers it in our DB.
 *
 * Usage:
 *   HOUSE_MAILBOX_HOST=smtp.gmail.com \
 *   HOUSE_MAILBOX_PORT=587 \
 *   HOUSE_MAILBOX_USERNAME=seed1@yourdomain.com \
 *   HOUSE_MAILBOX_PASSWORD='app-specific-password' \
 *   HOUSE_MAILBOX_TYPE=smtp \
 *   npx tsx scripts/add-house-warmup-mailbox.ts
 *
 * Run once per real seed mailbox account. A handful (4-6) spread across
 * a couple of providers gives real variety instead of every customer
 * mailbox warming up against the exact same one or two accounts, which
 * is itself a detectable pattern.
 */
import { prisma } from '../src/lib/prisma.js';
import { encryptValue } from '../src/lib/crypto.js';
import { testSmtpConnection } from '../src/lib/smtp.js';
import { config } from '../src/config.js';

const HOUSE_API_KEY_LABEL = 'House Warmup Pool';

function getMailboxSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

async function main() {
  const host = process.env['HOUSE_MAILBOX_HOST'];
  const port = process.env['HOUSE_MAILBOX_PORT'] ? parseInt(process.env['HOUSE_MAILBOX_PORT'], 10) : 587;
  const username = process.env['HOUSE_MAILBOX_USERNAME'];
  const password = process.env['HOUSE_MAILBOX_PASSWORD'];
  const type = process.env['HOUSE_MAILBOX_TYPE'] ?? 'smtp';

  if (!host || !username || !password) {
    console.error('Missing required env vars: HOUSE_MAILBOX_HOST, HOUSE_MAILBOX_USERNAME, HOUSE_MAILBOX_PASSWORD');
    process.exit(1);
  }

  // Find or create the single internal ApiKey record that owns every
  // house-pool mailbox — a real customer's own key must never own these,
  // so a customer deleting/downgrading their account can never take a
  // shared pool mailbox down with it.
  let houseKey = await prisma.apiKey.findFirst({ where: { label: HOUSE_API_KEY_LABEL } });
  if (!houseKey) {
    const { generateApiKey, hashApiKey, getKeyPrefix } = await import('../src/lib/crypto.js');
    const raw = generateApiKey();
    houseKey = await prisma.apiKey.create({
      data: { keyHash: hashApiKey(raw), keyPrefix: getKeyPrefix(raw), label: HOUSE_API_KEY_LABEL, plan: 'scale' },
    });
    console.log('Created house ApiKey record:', houseKey.id, '(this key is never used for API auth, only to own house mailboxes)');
  }

  const passwordEnc = encryptValue(password, getMailboxSecret());

  console.log(`Testing SMTP connection to ${host}:${port} as ${username}...`);
  const smtpResult = await testSmtpConnection({ host, port, username, passwordEnc, oauthTokenEnc: null });
  if (!smtpResult.ok) {
    console.error('SMTP connection test failed:', smtpResult.error);
    process.exit(1);
  }
  console.log('SMTP connection OK.');

  const mailbox = await prisma.mailbox.create({
    data: {
      apiKeyId: houseKey.id,
      type,
      host,
      port,
      username,
      passwordEnc,
      dailyLimit: 200,
      status: 'active',
      lastCheckedAt: new Date(),
      isHousePool: true,
    },
  });
  console.log('Registered house-pool mailbox:', mailbox.id, username);

  await prisma.warmupConfig.create({
    data: {
      mailboxId: mailbox.id,
      enabled: true,
      targetPerDay: 40,
      rampUpDays: 30,
      poolTier: 'premium', // house mailboxes always auto-open/reply — see poolTier gate in warmupWorker.ts
    },
  });
  console.log('Enabled warmup for this mailbox.');

  const totalHouseMailboxes = await prisma.mailbox.count({ where: { isHousePool: true, status: 'active' } });
  console.log(`\nTotal active house-pool mailboxes now: ${totalHouseMailboxes}.`);
  if (totalHouseMailboxes < 3) {
    console.log('Add a few more (aim for 4-6 across at least 2 providers) before relying on this for real customer warmup traffic.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

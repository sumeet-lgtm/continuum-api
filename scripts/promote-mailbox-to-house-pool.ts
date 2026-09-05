/**
 * Promotes an ALREADY-CONNECTED mailbox (an existing Mailbox row, found by
 * username) to house-pool status, instead of creating a duplicate row the
 * way add-house-warmup-mailbox.ts would — needed when a mailbox was
 * originally connected as a regular customer mailbox before it was decided
 * to use it as a house seed instead. Optionally refreshes its credentials
 * (useful when the first connection attempt used the wrong password, as
 * happened here) and always skips the warmup ramp, same reasoning as
 * add-house-warmup-mailbox.ts: a real account with months of prior sending
 * history shouldn't be throttled down to 5/day and slow-ramped back up.
 *
 * Usage:
 *   PROMOTE_USERNAME=sumeet.sutar@tryreconsignal.com \
 *   PROMOTE_PASSWORD='app-specific-password' \   # optional — omit to keep existing creds
 *   npx tsx scripts/promote-mailbox-to-house-pool.ts
 */
import { prisma } from '../src/lib/prisma.js';
import { encryptValue } from '../src/lib/crypto.js';
import { testSmtpConnection } from '../src/lib/smtp.js';
import { config } from '../src/config.js';

function getMailboxSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

async function main() {
  const username = process.env['PROMOTE_USERNAME'];
  const password = process.env['PROMOTE_PASSWORD'];
  const targetPerDay = process.env['PROMOTE_TARGET_PER_DAY'] ? parseInt(process.env['PROMOTE_TARGET_PER_DAY'], 10) : 40;

  if (!username) {
    console.error('Missing required env var: PROMOTE_USERNAME');
    process.exit(1);
  }

  const mailbox = await prisma.mailbox.findFirst({ where: { username } });
  if (!mailbox) {
    console.error(`No existing mailbox found for ${username} — use add-house-warmup-mailbox.ts instead to register it fresh.`);
    process.exit(1);
  }

  let passwordEnc = mailbox.passwordEnc;
  if (password) {
    passwordEnc = encryptValue(password, getMailboxSecret());
    const host = mailbox.host ?? 'smtp.gmail.com';
    const port = mailbox.port ?? 587;
    console.log(`Testing SMTP connection to ${host}:${port} as ${username}...`);
    const smtpResult = await testSmtpConnection({ host, port, username, passwordEnc, oauthTokenEnc: null });
    if (!smtpResult.ok) {
      console.error('SMTP connection test failed:', smtpResult.error);
      process.exit(1);
    }
    console.log('SMTP connection OK.');
  }

  await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: {
      isHousePool: true,
      status: 'active',
      lastErrorMsg: null,
      ...(password ? { passwordEnc, lastCheckedAt: new Date() } : {}),
    },
  });
  console.log('Promoted to house-pool:', mailbox.id, username);

  await prisma.warmupConfig.upsert({
    where: { mailboxId: mailbox.id },
    create: { mailboxId: mailbox.id, enabled: true, targetPerDay, currentPerDay: targetPerDay, rampUpDays: 30, poolTier: 'premium' },
    update: { enabled: true, targetPerDay, currentPerDay: targetPerDay, poolTier: 'premium' },
  });
  console.log(`Warmup enabled — already warm, starting at full target/day (${targetPerDay}), no ramp.`);

  const totalHouseMailboxes = await prisma.mailbox.count({ where: { isHousePool: true, status: 'active' } });
  console.log(`\nTotal active house-pool mailboxes now: ${totalHouseMailboxes}.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

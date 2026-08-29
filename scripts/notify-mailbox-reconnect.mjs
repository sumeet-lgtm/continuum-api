// One-off: email the owner(s) of every mailbox marked status=error with the
// reconnect message from mark-mailboxes-reconnect.mjs. Run after that script.
import { PrismaClient } from '@prisma/client';
import { sendEmail, mailboxReconnectEmail } from '../dist/lib/email.js';

const prisma = new PrismaClient();

const RECONNECT_MSG = 'Security update: mailbox credentials were re-encrypted with a new key. Please reconnect this mailbox.';

const mailboxes = await prisma.mailbox.findMany({
  where: { status: 'error', lastErrorMsg: RECONNECT_MSG },
  select: { id: true, username: true, apiKeyId: true },
});

console.log(`Found ${mailboxes.length} mailbox(es) to notify.`);

for (const mb of mailboxes) {
  const apiKey = await prisma.apiKey.findUnique({ where: { id: mb.apiKeyId }, select: { ownerId: true } });
  if (!apiKey?.ownerId) { console.log(`  ${mb.username}: no owner on API key, skipping`); continue; }
  const user = await prisma.user.findUnique({ where: { id: apiKey.ownerId }, select: { email: true, firstName: true } });
  if (!user?.email) { console.log(`  ${mb.username}: owner has no email, skipping`); continue; }

  const msg = mailboxReconnectEmail(mb.username, RECONNECT_MSG, user.firstName);
  await sendEmail(user.email, msg.subject, msg.html);
  console.log(`  ${mb.username}: emailed ${user.email}`);
}

await prisma.$disconnect();

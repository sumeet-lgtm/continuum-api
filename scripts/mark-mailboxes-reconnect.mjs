// One-off: after rotating MAILBOX_CREDS_SECRET, every mailbox with stored
// credentials is now undecryptable with the new key. Mark them so the
// dashboard shows a clear reconnect prompt instead of a silent failure on
// next send/warmup-check.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MESSAGE = 'Security update: mailbox credentials were re-encrypted with a new key. Please reconnect this mailbox.';

const result = await prisma.mailbox.updateMany({
  where: {
    OR: [{ passwordEnc: { not: null } }, { oauthTokenEnc: { not: null } }],
  },
  data: { status: 'error', lastErrorMsg: MESSAGE },
});

console.log(`Marked ${result.count} mailbox(es) as needing reconnection.`);
await prisma.$disconnect();

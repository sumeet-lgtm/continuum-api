import { Worker, type Job } from 'bullmq';
import { QUEUE_IMAP, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

interface ImapTickPayload {
  tick: true;
}

async function pollMailboxes(): Promise<void> {
  const cfg = config as Record<string, unknown>;
  if (!cfg['IMAP_POLL_ENABLED']) return;

  const mailboxes = await prisma.mailbox.findMany({
    where: { status: 'active', passwordEnc: { not: null } },
    select: { id: true, type: true, host: true, port: true, username: true, passwordEnc: true },
  });

  for (const mailbox of mailboxes) {
    try {
      // Dynamically import imap-simple only when IMAP polling is enabled
      // This avoids startup failures when the package isn't installed
      const imap = await import('imap-simple').catch(() => null);
      if (!imap) {
        logger.warn('imap-simple not installed — skipping IMAP poll');
        break;
      }

      // Import crypto to decrypt password
      const { decryptValue } = await import('../lib/crypto.js');
      const mailboxSecret = (config as Record<string, unknown>)['MAILBOX_CREDS_SECRET'] as string ?? config.API_KEY_SALT;
      const password = decryptValue(mailbox.passwordEnc!, mailboxSecret);

      const connection = await imap.connect({
        imap: {
          user: mailbox.username,
          password,
          host: mailbox.host ?? 'imap.gmail.com',
          port: mailbox.port ?? 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 10000,
        },
      });

      await connection.openBox('INBOX');
      const since = new Date(Date.now() - 15 * 60 * 1000); // Last 15 minutes
      const messages = await connection.search(['UNSEEN', ['SINCE', since.toUTCString()]], {
        bodies: ['HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO MESSAGE-ID)'],
        markSeen: false,
      });

      for (const msg of messages) {
        const header = msg.parts.find((p: { which: string }) => p.which.includes('HEADER'));
        if (!header) continue;

        const imap2 = await import('imap').catch(() => null);
        if (!imap2) continue;
        const parsed = imap2.default?.parseHeader?.(header.body as string) ?? {};

        const inReplyTo = (parsed['in-reply-to']?.[0] ?? '').replace(/[<>]/g, '');
        const fromEmail = (parsed['from']?.[0] ?? '').match(/<(.+?)>|(.+)/)?.[1] ?? '';
        const subject = parsed['subject']?.[0] ?? '';

        // Find matching enrollment by in-reply-to header
        let enrollmentId: string | null = null;
        if (inReplyTo) {
          const enrollment = await prisma.sequenceEnrollment.findFirst({
            where: { email: fromEmail.toLowerCase() },
            select: { id: true, sequenceId: true, status: true },
          });
          if (enrollment && enrollment.status === 'active') {
            enrollmentId = enrollment.id;

            // Check sequence stop_on_reply
            const seq = await prisma.sequence.findUnique({
              where: { id: enrollment.sequenceId },
              select: { stopOnReply: true },
            });

            if (seq?.stopOnReply) {
              await prisma.sequenceEnrollment.update({
                where: { id: enrollment.id },
                data: { status: 'replied', repliedAt: new Date() },
              });
              await prisma.lead.updateMany({
                where: { email: fromEmail.toLowerCase() },
                data: { status: 'replied', repliedAt: new Date() },
              }).catch(() => { /* lead may not exist */ });
            }
          }
        }

        // Persist reply event
        await prisma.replyEvent.create({
          data: {
            mailboxId: mailbox.id,
            fromEmail: fromEmail.toLowerCase(),
            inReplyToMessageId: inReplyTo || null,
            enrollmentId: enrollmentId,
            subject: subject || null,
          },
        }).catch(() => { /* ignore duplicates */ });
      }

      connection.end();
    } catch (err) {
      logger.error({ err, mailboxId: mailbox.id }, 'IMAP poll failed for mailbox');
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { lastErrorMsg: err instanceof Error ? err.message : 'IMAP error', lastCheckedAt: new Date() },
      }).catch(() => { /* ignore */ });
    }
  }
}

export function startImapWorker(): Worker {
  const worker = new Worker<ImapTickPayload>(
    QUEUE_IMAP,
    async (_job: Job<ImapTickPayload>) => {
      await pollMailboxes();
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'IMAP tick failed');
  });

  return worker;
}

export async function scheduleImapTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
    jobId: 'imap-tick-repeat',
  });
}

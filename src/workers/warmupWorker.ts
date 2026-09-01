import { Worker, type Job } from 'bullmq';
import { QUEUE_WARMUP, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSmtp } from '../lib/smtp.js';
import { decryptValue } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { deriveImapHost, IMAP_PORT } from '../lib/imapHost.js';

interface WarmupTickPayload {
  tick: true;
}

function getTodayTarget(wc: { targetPerDay: number; currentPerDay: number; rampUpDays: number; dailyRampUp?: number | null; startedAt: Date }): number {
  const dailyRampUp = wc.dailyRampUp ?? 2;
  const daysRunning = Math.floor((Date.now() - wc.startedAt.getTime()) / (1000 * 60 * 60 * 24));
  if (daysRunning >= wc.rampUpDays) return wc.targetPerDay;
  // Use explicit dailyRampUp increment if provided, otherwise use linear interpolation
  const rampTarget = Math.min(wc.targetPerDay, wc.currentPerDay + dailyRampUp);
  return Math.max(5, rampTarget);
}

const WARMUP_SUBJECTS = [
  'Quick question', 'Following up', 'Thoughts on this?', 'Re: our conversation',
  'Checking in', 'Quick note', 'Any updates?', 'Just checking in',
  'Wanted to share something', 'Re: next steps', 'One quick thing',
];

const WARMUP_BODIES = [
  'Hi, just wanted to follow up on our earlier conversation. Let me know your thoughts.',
  'Hope you\'re doing well! I wanted to share a quick update. Looking forward to hearing from you.',
  'Thanks for your time. Just circling back to make sure we\'re aligned. Any questions?',
  'Hi there! Checking in to see if you had a chance to review what I sent over.',
  'Just a quick note to keep things moving. Would love to hear back when you get a chance.',
  'Hope your week is going well. Reaching out to touch base on our last conversation.',
];

const WARMUP_REPLIES = [
  'Thanks for reaching out! Will get back to you shortly.',
  'Got it, thanks for the update. Will follow up soon.',
  'Appreciate the note. I\'ll take a look and respond.',
  'Thanks! This is helpful. Chat soon.',
  'Got your message. Will circle back by end of week.',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function getMailboxSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

interface WarmupMailboxCreds {
  host: string | null;
  port: number | null;
  username: string;
  passwordEnc: string | null;
  oauthTokenEnc: string | null;
}

async function buildImapAuth(mailbox: WarmupMailboxCreds): Promise<{ password?: string; xoauth2?: string }> {
  if (mailbox.oauthTokenEnc) {
    const { getOAuthAccessToken, buildXoauth2Token } = await import('../lib/oauth/tokens.js');
    const { accessToken } = await getOAuthAccessToken(mailbox.oauthTokenEnc);
    return { xoauth2: buildXoauth2Token(mailbox.username, accessToken) };
  }
  return { password: decryptValue(mailbox.passwordEnc!, getMailboxSecret()) };
}

async function autoOpenAndReply(
  targetMailbox: WarmupMailboxCreds,
  fromMailbox: WarmupMailboxCreds,
  warmupSubject: string,
  shouldReply: boolean,
): Promise<void> {
  if (!(targetMailbox.passwordEnc || targetMailbox.oauthTokenEnc) || !targetMailbox.host) return;

  try {
    const imap = await import('imap-simple').catch(() => null);
    if (!imap) return;

    const authConfig = await buildImapAuth(targetMailbox);

    const connection = await imap.connect({
      // Cast: node-imap's types mark password required even when xoauth2
      // is supplied instead (see imapHost.ts for the same note).
      imap: {
        user: targetMailbox.username,
        host: deriveImapHost(targetMailbox.host),
        port: IMAP_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
        ...authConfig,
      } as import('imap').Config,
    });

    // Search for the warmup email in INBOX
    await connection.openBox('INBOX');
    const since = new Date(Date.now() - 10 * 60 * 1000); // Last 10 min
    const messages = await connection.search(
      ['UNSEEN', ['FROM', fromMailbox.username], ['SINCE', since.toUTCString()]],
      { bodies: ['HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)'], markSeen: true },
    );

    for (const msg of messages) {
      const header = msg.parts.find((p: { which: string }) => p.which.includes('HEADER'));
      if (!header) continue;

      const imapLib = await import('imap').catch(() => null);
      if (!imapLib) continue;
      const parsed = imapLib.default?.parseHeader?.(header.body as string) ?? {};
      const subject = parsed['subject']?.[0] ?? '';

      if (!subject.toLowerCase().includes(warmupSubject.toLowerCase().slice(0, 10))) continue;

      // Mark as read (already done by markSeen: true above)
      // Try to move from spam/promotions to INBOX if it landed there
      // (already opened INBOX, so this is for emails that arrived there)

      // Optionally send a short reply, FROM the target mailbox BACK to the
      // source mailbox — so the target mailbox needs SMTP creds too.
      if (shouldReply && (targetMailbox.passwordEnc || targetMailbox.oauthTokenEnc) && targetMailbox.host) {
        const targetSmtp = {
          host: targetMailbox.host,
          port: targetMailbox.port ?? 587,
          username: targetMailbox.username,
          passwordEnc: targetMailbox.passwordEnc,
          oauthTokenEnc: targetMailbox.oauthTokenEnc,
        };
        await sendViaSmtp(targetSmtp, {
          from: targetMailbox.username,
          to: fromMailbox.username,
          subject: `Re: ${subject}`,
          textBody: randomItem(WARMUP_REPLIES),
        }).catch(err => logger.debug({ err }, 'Warmup reply send failed (non-fatal)'));
      }

      break; // Process one warmup email per tick per mailbox pair
    }

    connection.end();
  } catch (err) {
    logger.debug({ err, mailbox: targetMailbox.username }, 'Warmup IMAP auto-open failed (non-fatal)');
  }
}

async function processWarmupTick(): Promise<void> {
  const cfg = config as Record<string, unknown>;
  if (!cfg['WARMUP_POOL_ENABLED']) return;

  // Get all enabled warmup configs with their mailboxes
  const warmupConfigs = await prisma.warmupConfig.findMany({
    where: { enabled: true },
    include: { mailbox: true },
  });

  if (warmupConfigs.length < 2) {
    logger.info('Not enough mailboxes in warmup pool — need at least 2');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const wc of warmupConfigs) {
    const { mailbox } = wc;
    if (mailbox.status !== 'active') continue;
    if (!(mailbox.passwordEnc || mailbox.oauthTokenEnc) || !mailbox.host) {
      logger.warn({ mailboxId: mailbox.id }, 'Warmup mailbox missing SMTP credentials — skipping');
      continue;
    }

    // Reset sentToday if it's a new day
    if (mailbox.sentTodayResetAt < today) {
      await prisma.mailbox.update({ where: { id: mailbox.id }, data: { sentToday: 0, sentTodayResetAt: today } });
      mailbox.sentToday = 0;
    }

    const todayTarget = getTodayTarget(wc);
    const remaining = todayTarget - mailbox.sentToday;
    if (remaining <= 0) continue;

    // Pick a random different mailbox to send to
    const otherMailboxes = warmupConfigs.filter(w => w.mailboxId !== wc.mailboxId && w.mailbox.status === 'active' && w.mailbox.host);
    if (otherMailboxes.length === 0) continue;

    const target = randomItem(otherMailboxes);
    const sendCount = Math.min(remaining, Math.ceil(todayTarget / 24)); // Spread sends throughout the day

    for (let i = 0; i < sendCount; i++) {
      const subject = randomItem(WARMUP_SUBJECTS);
      const body = randomItem(WARMUP_BODIES);
      const poolTier = wc.poolTier ?? 'standard';
      const replyRate = (wc.replyRatePct ?? 20) / 100;
      const shouldReply = Math.random() < replyRate;

      try {
        // Send warmup email FROM this mailbox TO the target mailbox via SMTP
        await sendViaSmtp(
          {
            host: mailbox.host!,
            port: mailbox.port ?? 587,
            username: mailbox.username,
            passwordEnc: mailbox.passwordEnc,
            oauthTokenEnc: mailbox.oauthTokenEnc,
          },
          {
            from: mailbox.username,
            to: target.mailbox.username,
            subject,
            htmlBody: `<p>${body}</p>`,
            textBody: body,
            headers: { 'X-Warmup-Pool': 'continuum', 'X-Warmup-Tier': poolTier },
          },
        );

        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { sentToday: { increment: 1 } },
        });

        // Auto-open/reply in the target mailbox (standard and premium)
        if (poolTier !== 'basic' && target.mailbox.host) {
          // Small delay before IMAP check so the email has time to arrive
          await new Promise(r => setTimeout(r, 5000));
          await autoOpenAndReply(
            { ...target.mailbox, host: target.mailbox.host },
            { ...mailbox, host: mailbox.host },
            subject,
            shouldReply,
          );
        }

        // Human-like delay between warmup sends (30-90 seconds)
        await new Promise(r => setTimeout(r, 30000 + Math.random() * 60000));
      } catch (err) {
        logger.error({ err, mailboxId: mailbox.id, targetMailboxId: target.mailboxId }, 'Warmup send failed');
        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { lastErrorMsg: err instanceof Error ? err.message : 'SMTP warmup error' },
        }).catch(() => {});
      }
    }

    // Update currentPerDay on warmup config — ramp once per day
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const wcAny = wc as { lastRampDate?: string | null };
    if (wcAny.lastRampDate !== todayStr) {
      await prisma.warmupConfig.update({
        where: { id: wc.id },
        data: { currentPerDay: todayTarget, lastRampDate: todayStr } as never,
      });
    }
  }
}

export function startWarmupWorker(): Worker {
  const worker = new Worker<WarmupTickPayload>(
    QUEUE_WARMUP,
    async (_job: Job<WarmupTickPayload>) => {
      await processWarmupTick();
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Warmup tick failed');
  });

  return worker;
}

export async function scheduleWarmupTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 60 * 60 * 1000 }, // every hour
    jobId: 'warmup-tick-repeat',
  });
}

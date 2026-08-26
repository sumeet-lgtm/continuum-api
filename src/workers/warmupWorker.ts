import { Worker, type Job } from 'bullmq';
import { QUEUE_WARMUP, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSes } from '../lib/ses.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

interface WarmupTickPayload {
  tick: true;
}

function getTodayTarget(wc: { targetPerDay: number; rampUpDays: number; startedAt: Date }): number {
  const daysRunning = Math.floor((Date.now() - wc.startedAt.getTime()) / (1000 * 60 * 60 * 24));
  if (daysRunning >= wc.rampUpDays) return wc.targetPerDay;
  return Math.max(5, Math.round(5 + (wc.targetPerDay - 5) * daysRunning / wc.rampUpDays));
}

const WARMUP_SUBJECTS = [
  'Quick question', 'Following up', 'Thoughts on this?', 'Re: our conversation',
  'Checking in', 'Quick note', 'Any updates?', 'Just checking in',
];

const WARMUP_BODIES = [
  'Hi, just wanted to follow up on our earlier conversation. Let me know your thoughts.',
  'Hope you\'re doing well! I wanted to share a quick update. Looking forward to hearing from you.',
  'Thanks for your time. Just circling back to make sure we\'re aligned. Any questions?',
  'Hi there! Checking in to see if you had a chance to review what I sent over.',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
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

    // Reset sentToday if it's a new day
    if (mailbox.sentTodayResetAt < today) {
      await prisma.mailbox.update({ where: { id: mailbox.id }, data: { sentToday: 0, sentTodayResetAt: today } });
      mailbox.sentToday = 0;
    }

    const todayTarget = getTodayTarget(wc);
    const remaining = todayTarget - mailbox.sentToday;
    if (remaining <= 0) continue;

    // Pick a random different mailbox to send to
    const otherMailboxes = warmupConfigs.filter(w => w.mailboxId !== wc.mailboxId && w.mailbox.status === 'active');
    if (otherMailboxes.length === 0) continue;

    const target = randomItem(otherMailboxes);
    const sendCount = Math.min(remaining, Math.ceil(todayTarget / 24)); // Spread sends throughout the day

    for (let i = 0; i < sendCount; i++) {
      try {
        await sendViaSes({
          from: mailbox.username,
          to: target.mailbox.username,
          subject: randomItem(WARMUP_SUBJECTS),
          htmlBody: `<p>${randomItem(WARMUP_BODIES)}</p>`,
          textBody: randomItem(WARMUP_BODIES),
        });

        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { sentToday: { increment: 1 } },
        });

        // Delay between warmup sends
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.error({ err, mailboxId: mailbox.id }, 'Warmup send failed');
      }
    }

    // Update currentPerDay on warmup config
    await prisma.warmupConfig.update({
      where: { id: wc.id },
      data: { currentPerDay: todayTarget },
    });
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

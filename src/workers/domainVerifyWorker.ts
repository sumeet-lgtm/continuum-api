import { Worker, type Job } from 'bullmq';
import { QUEUE_DOMAIN_VERIFY, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { verifyDomain } from '../lib/domainVerify.js';
import { logger } from '../lib/logger.js';

interface DomainVerifyTickPayload {
  tick: true;
}

// The self-serve gap this closes: a customer adds their sending domain,
// gets back DNS records, adds them, and — before this worker existed —
// nothing ever rechecked verification status again unless they came back
// and clicked "Re-verify DNS" themselves. SES's own DKIM check runs on its
// own schedule (minutes to hours after the DNS record is actually live),
// so "verification happens automatically" in the dashboard's own copy was
// not true. This tick makes that claim actually true.
export async function processDomainVerifyTick(): Promise<void> {
  const pending = await prisma.sendingDomain.findMany({
    where: { status: 'pending' },
    select: { id: true, apiKeyId: true, name: true, region: true, dkimStatus: true, verifiedAt: true },
  });

  if (pending.length === 0) return;

  let verifiedCount = 0;
  for (const domain of pending) {
    try {
      const { justVerified } = await verifyDomain(domain);
      if (justVerified) verifiedCount++;
    } catch (err) {
      logger.warn({ err, domainId: domain.id, domain: domain.name }, 'Background domain re-verify failed for this domain (non-fatal, will retry next tick)');
    }
  }

  logger.info({ checked: pending.length, verified: verifiedCount }, 'Domain verify tick complete');
}

export function startDomainVerifyWorker(): Worker {
  const worker = new Worker<DomainVerifyTickPayload>(
    QUEUE_DOMAIN_VERIFY,
    async (_job: Job<DomainVerifyTickPayload>) => {
      await processDomainVerifyTick();
    },
    { connection: redisConnection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Domain verify tick failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Domain verify worker error (non-fatal)');
  });

  return worker;
}

export async function scheduleDomainVerifyTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
    jobId: 'domain-verify-tick-repeat',
  });
}

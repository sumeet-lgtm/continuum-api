import { Worker, type Job } from 'bullmq';
import { QUEUE_CAMPAIGN, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSes } from '../lib/ses.js';
import { generateUnsubToken, generateUnsubHtml } from '../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../lib/tracking.js';
import { processTemplate } from '../lib/spintax.js';
import { logger } from '../lib/logger.js';

interface CampaignJobData {
  campaignId: string;
  apiKeyId: string;
}

async function processCampaign(job: Job<CampaignJobData>): Promise<void> {
  const { campaignId, apiKeyId } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status === 'cancelled') return;

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'sending' } });

  // Resolve all recipient emails from list_ids
  const listIds = campaign.listIds as string[];
  const excludeListIds = campaign.excludeListIds as string[];

  // Get all subscribed contacts from lists
  const memberships = await prisma.contactListMembership.findMany({
    where: {
      listId: { in: listIds },
      status: 'subscribed',
      ...(excludeListIds.length > 0 ? { NOT: { listId: { in: excludeListIds } } } : {}),
    },
    include: { contact: { select: { email: true, firstName: true, lastName: true } } },
  });

  // Deduplicate by email
  const seen = new Set<string>();
  const recipients: Array<{ email: string; firstName: string | null; lastName: string | null }> = [];
  for (const m of memberships) {
    if (!seen.has(m.contact.email)) {
      seen.add(m.contact.email);
      recipients.push(m.contact);
    }
  }

  // Remove suppressed emails
  const suppressions = await prisma.suppression.findMany({
    where: { email: { in: recipients.map(r => r.email) } },
    select: { email: true },
  });
  const suppressedSet = new Set(suppressions.map(s => s.email));
  const validRecipients = recipients.filter(r => !suppressedSet.has(r.email));

  // Create recipient rows
  await prisma.campaignRecipient.createMany({
    data: validRecipients.map(r => ({ campaignId, email: r.email, status: 'pending' })),
    skipDuplicates: true,
  });

  await prisma.campaign.update({ where: { id: campaignId }, data: { totalRecipients: validRecipients.length } });

  const fromAddress = `${campaign.fromName} <${campaign.fromEmail}>`;
  const CHUNK_SIZE = 50;
  let sentCount = 0;

  for (let i = 0; i < validRecipients.length; i += CHUNK_SIZE) {
    // Check if campaign was cancelled mid-flight
    const current = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (current?.status === 'cancelled') {
      logger.info({ campaignId }, 'Campaign cancelled mid-send');
      break;
    }

    let chunk = validRecipients.slice(i, i + CHUNK_SIZE);

    // Re-check suppression per chunk, not just once at campaign start — a
    // large list can take minutes to send, and someone who unsubscribes or
    // bounces on a completely different channel (a reply to a transactional
    // email, a different campaign) partway through must not still get a
    // later chunk just because they weren't suppressed yet when this
    // campaign began.
    if (i > 0) {
      const freshlySuppressed = await prisma.suppression.findMany({
        where: { email: { in: chunk.map(r => r.email) } },
        select: { email: true },
      });
      if (freshlySuppressed.length > 0) {
        const freshSet = new Set(freshlySuppressed.map(s => s.email));
        await prisma.campaignRecipient.updateMany({
          where: { campaignId, email: { in: [...freshSet] } },
          data: { status: 'suppressed' },
        }).catch(() => {});
        chunk = chunk.filter(r => !freshSet.has(r.email));
      }
    }

    await Promise.allSettled(chunk.map(async recipient => {
      try {
        const vars = {
          first_name: recipient.firstName ?? 'there',
          last_name: recipient.lastName ?? '',
          email: recipient.email,
          unsubscribe_url: `https://api.continuumapi.com/v1/unsubscribe?token=${generateUnsubToken(recipient.email, apiKeyId)}`,
        };

        const subject = processTemplate(campaign.subject, vars);
        let htmlBody = processTemplate(campaign.htmlBody, vars);
        const textBody = campaign.textBody ? processTemplate(campaign.textBody, vars) : undefined;

        const unsubToken = generateUnsubToken(recipient.email, apiKeyId);
        const trackingId = `${campaignId}_${recipient.email}`;

        if (campaign.trackOpens || campaign.trackClicks) {
          htmlBody = htmlBody.replace(/<\/body>/i, `${generateUnsubHtml(unsubToken)}</body>`);
          htmlBody = injectTracking(
            htmlBody,
            campaign.trackOpens ? generateOpenToken(trackingId) : '',
            url => campaign.trackClicks ? generateClickToken(trackingId, url) : url,
          );
        }

        const { sesMessageId } = await sendViaSes({
          to: recipient.email, from: fromAddress, subject,
          htmlBody,
          ...(textBody ? { textBody } : {}),
          ...(campaign.replyTo ? { replyTo: campaign.replyTo } : {}),
          listUnsubscribeHeader: `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`,
        });

        await prisma.campaignRecipient.updateMany({
          where: { campaignId, email: recipient.email },
          data: { status: 'sent', sesMessageId, sentAt: new Date() },
        });

        sentCount++;
      } catch (err) {
        logger.error({ err, email: recipient.email, campaignId }, 'Campaign send to recipient failed');
        await prisma.campaignRecipient.updateMany({
          where: { campaignId, email: recipient.email },
          data: { status: 'failed' },
        });
      }
    }));

    // Update progress
    await prisma.campaign.update({ where: { id: campaignId }, data: { sentCount } });

    // Rate limiting: 100ms between chunks to stay under SES limit
    if (i + CHUNK_SIZE < validRecipients.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'sent', sentAt: new Date(), sentCount },
  });

  logger.info({ campaignId, sentCount, total: validRecipients.length }, 'Campaign send complete');
}

export function startCampaignWorker(): Worker {
  const worker = new Worker<CampaignJobData>(
    QUEUE_CAMPAIGN,
    async (job) => {
      await processCampaign(job);
    },
    {
      connection: redisConnection,
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, campaignId: job.data.campaignId }, 'Campaign job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Campaign job failed');
  });

  return worker;
}

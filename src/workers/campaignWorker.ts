import { Worker, type Job } from 'bullmq';
import { QUEUE_CAMPAIGN, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSes } from '../lib/ses.js';
import { generateUnsubToken, generateUnsubHtml } from '../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../lib/tracking.js';
import { processTemplate } from '../lib/spintax.js';
import { logger } from '../lib/logger.js';
import { dispatchWebhook, buildEventId } from '../lib/webhooks.js';

interface CampaignJobData {
  campaignId: string;
  apiKeyId: string;
}

export async function processCampaign(job: Job<CampaignJobData>): Promise<void> {
  const { campaignId, apiKeyId } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status === 'cancelled') return;

  // Retarget campaigns carry a pre-computed list of emails to exclude
  // (openers from the source campaign). This avoids suppressing them globally.
  const retargetExcludeSet = new Set<string>(
    (campaign.excludedEmails as string[] | null) ?? []
  );

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'sending' } });

  // Resolve all recipient emails from list_ids
  const listIds = campaign.listIds as string[];
  const segmentIds = campaign.segmentIds as string[];
  const excludeListIds = campaign.excludeListIds as string[];

  // Get all subscribed contacts from lists
  const memberships = await prisma.contactListMembership.findMany({
    where: {
      ...(listIds.length > 0 ? { listId: { in: listIds } } : {}),
      status: 'subscribed',
      ...(excludeListIds.length > 0 ? { NOT: { listId: { in: excludeListIds } } } : {}),
    },
    include: { contact: { select: { email: true, firstName: true, lastName: true, customFields: true } } },
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

  // Resolve segment recipients and merge
  if (segmentIds.length > 0) {
    const segments = await prisma.segment.findMany({
      where: { id: { in: segmentIds }, apiKeyId },
      select: { id: true, listId: true, filterRules: true },
    });
    for (const seg of segments) {
      if (!seg.listId) continue;
      const segMemberships = await prisma.contactListMembership.findMany({
        where: { listId: seg.listId, status: 'subscribed' },
        include: { contact: { select: { email: true, firstName: true, lastName: true, customFields: true } } },
      });
      const rules = seg.filterRules as Array<{ field: string; operator: string; value: string }>;
      for (const m of segMemberships) {
        if (seen.has(m.contact.email)) continue;
        if (matchSegmentRules(m.contact, rules)) {
          seen.add(m.contact.email);
          recipients.push(m.contact);
        }
      }
    }
  }

  // Remove suppressed emails
  const suppressions = await prisma.suppression.findMany({
    where: { email: { in: recipients.map(r => r.email) } },
    select: { email: true },
  });
  const suppressedSet = new Set(suppressions.map(s => s.email));
  const validRecipients = recipients.filter(r =>
    !suppressedSet.has(r.email) && !retargetExcludeSet.has(r.email)
  );

  // Assign A/B variants before creating recipient rows (50/50 random split)
  const isABTest = !!campaign.subjectB;
  const recipientVariants = new Map<string, 'a' | 'b'>();
  if (isABTest) {
    // Fisher-Yates shuffle then split for balanced 50/50
    const shuffled = [...validRecipients].sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);
    shuffled.forEach((r, idx) => {
      recipientVariants.set(r.email, idx < half ? 'a' : 'b');
    });
  }

  // Create recipient rows
  await prisma.campaignRecipient.createMany({
    data: validRecipients.map(r => ({
      campaignId,
      email: r.email,
      status: 'pending',
      variant: recipientVariants.get(r.email) ?? 'a',
    })),
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
        const recipientVariant = recipientVariants.get(recipient.email) ?? 'a';
        const vars = {
          first_name: recipient.firstName ?? 'there',
          last_name: recipient.lastName ?? '',
          email: recipient.email,
          unsubscribe_url: `https://api.continuumapi.com/v1/unsubscribe?token=${generateUnsubToken(recipient.email, apiKeyId)}`,
        };

        const rawSubject = (isABTest && recipientVariant === 'b' && campaign.subjectB) ? campaign.subjectB : campaign.subject;
        const subject = processTemplate(rawSubject, vars);
        let htmlBody = processTemplate(campaign.htmlBody, vars);
        const textBody = campaign.textBody ? processTemplate(campaign.textBody, vars) : undefined;

        // Inject preheader as a hidden div at the start of <body> (or top of HTML).
        // The trailing &nbsp;&zwnj; filler stops email clients from pulling the
        // next visible line of text into the preview pane.
        if (campaign.preheader) {
          const preheaderHtml = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${campaign.preheader}${'&nbsp;&zwnj;'.repeat(60)}</div>`;
          htmlBody = htmlBody.replace(/<body[^>]*>/i, (m) => `${m}${preheaderHtml}`);
          if (!htmlBody.includes('<body')) htmlBody = `${preheaderHtml}${htmlBody}`;
        }

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
          data: { status: 'sent', sesMessageId, sentAt: new Date(), variant: recipientVariant },
        });

        // Also register this send as a SendMessage row — the SES bounce/
        // complaint webhook (POST /v1/send/events) only knows how to match
        // an incoming SNS notification back to a SendMessage.sesMessageId.
        // Without this, campaign bounces had nowhere to land: no automatic
        // suppression, no closed-loop verification correction, nothing —
        // the recipient stayed fully sendable in every future campaign and
        // sequence despite having just hard-bounced.
        await prisma.sendMessage.create({
          data: {
            apiKeyId, to: recipient.email, from: fromAddress, subject,
            sesMessageId, status: 'sent', sentAt: new Date(),
            // Store the tracking token so the open/click pixel can find this
            // row — the SendMessage id is a cuid and the tracking token uses
            // campaignId_email, so without this the campaign open/click
            // counts can never be incremented.
            trackingToken: trackingId,
          },
        }).catch((err) => {
          logger.warn({ err, email: recipient.email, campaignId }, 'Failed to register campaign send for bounce tracking (non-fatal)');
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

    // Inter-chunk delay: honour drip rate if set, else 100ms to stay under SES burst limit.
    // sendRatePerHour = 300 → max 300 emails/hr → 50-email chunk every 600s.
    if (i + CHUNK_SIZE < validRecipients.length) {
      const rate = (campaign as unknown as { sendRatePerHour: number | null }).sendRatePerHour;
      const delayMs = rate && rate > 0
        ? Math.max(100, (CHUNK_SIZE / rate) * 3_600_000)
        : 100;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const finalCampaign = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'sent', sentAt: new Date(), sentCount },
    select: { id: true, name: true, subject: true, fromEmail: true, totalRecipients: true, sentCount: true, sentAt: true },
  });

  void dispatchWebhook({
    apiKeyId,
    event: 'campaign.sent',
    eventId: buildEventId('campaign.sent', campaignId),
    payload: {
      event: 'campaign.sent' as const,
      campaign_id: finalCampaign.id,
      name: finalCampaign.name,
      subject: finalCampaign.subject,
      from_email: finalCampaign.fromEmail,
      total_recipients: finalCampaign.totalRecipients,
      sent_count: finalCampaign.sentCount,
      sent_at: finalCampaign.sentAt?.toISOString(),
      apiVersion: '2' as const,
    },
  }).catch(() => {});

  logger.info({ campaignId, sentCount, total: validRecipients.length }, 'Campaign send complete');
}

function matchSegmentRules(contact: { email: string; firstName: string | null; lastName: string | null; customFields?: unknown }, rules: Array<{ field: string; operator: string; value: string }>): boolean {
  return rules.every(rule => {
    let fieldVal: string;
    if      (rule.field === 'email')      fieldVal = contact.email;
    else if (rule.field === 'first_name') fieldVal = contact.firstName ?? '';
    else if (rule.field === 'last_name')  fieldVal = contact.lastName ?? '';
    else if (rule.field.startsWith('custom.')) {
      const key = rule.field.slice(7);
      const cf = contact.customFields as Record<string, unknown> | null | undefined;
      fieldVal = cf ? String(cf[key] ?? '') : '';
    } else fieldVal = '';

    switch (rule.operator) {
      case 'equals':      return fieldVal.toLowerCase() === rule.value.toLowerCase();
      case 'not_equals':  return fieldVal.toLowerCase() !== rule.value.toLowerCase();
      case 'contains':    return fieldVal.toLowerCase().includes(rule.value.toLowerCase());
      case 'starts_with': return fieldVal.toLowerCase().startsWith(rule.value.toLowerCase());
      default:            return true;
    }
  });
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

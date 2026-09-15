import { Worker, type Job } from 'bullmq';
import { QUEUE_CAMPAIGN, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaTransportWithFallback, isSendTransportConfigured } from '../lib/sendTransport.js';
import { generateUnsubToken, generateUnsubHtml } from '../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../lib/tracking.js';
import { processTemplate } from '../lib/spintax.js';
import { logger } from '../lib/logger.js';
import { dispatchWebhook, buildEventId } from '../lib/webhooks.js';
import { getSendLimit, incrementSendUsageBy } from '../plugins/usageMeter.js';
import { withTenant, withRlsBypass } from '../lib/tenantContext.js';

interface CampaignJobData {
  campaignId: string;
  apiKeyId: string;
}

function isInSendWindow(campaign: { sendDays: string[]; sendStartHour: number; sendEndHour: number; timezone: string }): boolean {
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  try {
    const tz = campaign.timezone || 'UTC';
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const day = DAY_NAMES[nowInTz.getDay()] ?? 'sunday';
    const hour = nowInTz.getHours();
    const days = campaign.sendDays as string[];
    // No window configured = always in window
    if (!days || days.length === 0) return true;
    return days.includes(day) && hour >= campaign.sendStartHour && hour < campaign.sendEndHour;
  } catch {
    return true; // invalid timezone → don't block
  }
}

export async function processCampaign(job: Job<CampaignJobData>): Promise<void> {
  const { campaignId, apiKeyId } = job.data;

  if (!isSendTransportConfigured()) {
    await withTenant(apiKeyId, (tx) => tx.campaign.update({
      where: { id: campaignId },
      data: { status: 'failed', errorMessage: 'Email sending is not configured. Contact support.' },
    }));
    logger.error({ campaignId }, 'Campaign aborted — no send transport configured');
    return;
  }

  const campaign = await withTenant(apiKeyId, (tx) => tx.campaign.findUnique({ where: { id: campaignId } }));
  if (!campaign || campaign.status === 'cancelled') return;

  // Fetched once per campaign, not per recipient — a campaign can enroll
  // thousands of recipients, and this preference never changes mid-run.
  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { id: apiKeyId },
    select: { allowSendFallback: true },
  });
  const allowFallback = apiKeyRecord?.allowSendFallback ?? true;

  // Retarget campaigns carry a pre-computed list of emails to exclude
  // (openers from the source campaign). This avoids suppressing them globally.
  const retargetExcludeSet = new Set<string>(
    (campaign.excludedEmails as string[] | null) ?? []
  );

  await withTenant(apiKeyId, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'sending' } }));

  // Resolve all recipient emails from list_ids
  const listIds = campaign.listIds as string[];
  const segmentIds = campaign.segmentIds as string[];
  const excludeListIds = campaign.excludeListIds as string[];

  // A campaign must target an explicit list or segment — there is no safe
  // "everyone" default. An empty listIds used to fall through to a where
  // clause with NO filter at all (2026-09-14 incident: sent to 300
  // contacts that were never scoped to this account, since
  // ContactListMembership carries no apiKeyId of its own and the query
  // below wasn't joining through contact.apiKeyId either). Fail loudly
  // instead of resolving to an unbounded audience.
  if (listIds.length === 0 && segmentIds.length === 0) {
    await withTenant(apiKeyId, (tx) => tx.campaign.update({
      where: { id: campaignId },
      data: { status: 'failed', errorMessage: 'No list_ids or segment_ids specified — refusing to send to an unbounded audience.' },
    }));
    logger.error({ campaignId, apiKeyId }, 'Campaign aborted — no list_ids/segment_ids specified');
    return;
  }

  // Get all subscribed contacts from lists — always scoped to this
  // account's own contacts (contact.apiKeyId), even if a listId somehow
  // didn't belong to them, as defense in depth against cross-tenant leakage.
  const memberships = await withTenant(apiKeyId, (tx) => tx.contactListMembership.findMany({
    where: {
      listId: { in: listIds },
      status: 'subscribed',
      contact: { apiKeyId },
      ...(excludeListIds.length > 0 ? { NOT: { listId: { in: excludeListIds } } } : {}),
    },
    include: { contact: { select: { email: true, firstName: true, lastName: true, customFields: true } } },
  }));

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
    await withTenant(apiKeyId, async (tx) => {
      const segments = await tx.segment.findMany({
        where: { id: { in: segmentIds }, apiKeyId },
        select: { id: true, listId: true, filterRules: true },
      });
      for (const seg of segments) {
        if (!seg.listId) continue;
        const segMemberships = await tx.contactListMembership.findMany({
          where: { listId: seg.listId, status: 'subscribed', contact: { apiKeyId } },
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
    });
  }

  // Remove suppressed emails — Suppression is a platform-wide, deliberately
  // unscoped list (see schema.prisma); every tenant's sends must skip it.
  // withRlsBypass, not withTenant: this must see every tenant's
  // suppressions, not just this campaign's own apiKeyId.
  const suppressions = await withRlsBypass((tx) => tx.suppression.findMany({
    where: { email: { in: recipients.map(r => r.email) } },
    select: { email: true },
  }));
  const suppressedSet = new Set(suppressions.map(s => s.email));
  const validRecipients = recipients.filter(r =>
    !suppressedSet.has(r.email) && !retargetExcludeSet.has(r.email)
  );

  // Circuit breaker — independent of every resolution path above (list,
  // segment, retarget-exclude), verify every resolved recipient is
  // actually a Contact this account owns before anything sends. This is
  // deliberately redundant with the apiKeyId scoping already applied
  // upstream: it exists so that a FUTURE bug in how recipients get
  // resolved (a new query, a missed join, a refactor) fails the send
  // loudly instead of silently reaching contacts outside this account,
  // the way the 2026-09-14 incident did.
  if (validRecipients.length > 0) {
    const ownedCount = await withTenant(apiKeyId, (tx) => tx.contact.count({
      where: { apiKeyId, email: { in: validRecipients.map(r => r.email) } },
    }));
    if (ownedCount !== validRecipients.length) {
      await withTenant(apiKeyId, (tx) => tx.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'failed',
          errorMessage: `Recipient isolation check failed: resolved ${validRecipients.length} recipients but only ${ownedCount} are owned by this account. Send aborted before anything went out.`,
        },
      }));
      logger.error(
        { campaignId, apiKeyId, resolved: validRecipients.length, owned: ownedCount },
        'CRITICAL: campaign recipient isolation check failed — send aborted',
      );
      return;
    }
  }

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
  await withTenant(apiKeyId, (tx) => tx.campaignRecipient.createMany({
    data: validRecipients.map(r => ({
      campaignId,
      email: r.email,
      status: 'pending',
      variant: recipientVariants.get(r.email) ?? 'a',
    })),
    skipDuplicates: true,
  }));

  await withTenant(apiKeyId, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { totalRecipients: validRecipients.length } }));

  const fromAddress = `${campaign.fromName} <${campaign.fromEmail}>`;
  const CHUNK_SIZE = 50;
  let sentCount = 0;
  // Every `break` below only exits the loop — without this flag, execution
  // falls straight into the unconditional "mark sent + fire campaign.sent"
  // block after the loop, silently overwriting whatever status a break just
  // set (cancelled, paused_bounce, paused_quota) back to 'sent' a moment
  // later. That's why cancelling a campaign or tripping the bounce-rate
  // auto-pause never actually stuck in practice.
  let stoppedEarly = false;

  for (let i = 0; i < validRecipients.length; i += CHUNK_SIZE) {
    // Check if campaign was cancelled mid-flight or needs auto-pause for high bounce rate
    const current = await withTenant(apiKeyId, (tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true, bounceCount: true, sentCount: true } }));
    if (current?.status === 'cancelled') {
      logger.info({ campaignId }, 'Campaign cancelled mid-send');
      stoppedEarly = true;
      break;
    }
    // Auto-pause if bounce rate exceeds 5% and at least 50 sent — protects SES account health
    if (current && current.sentCount >= 50) {
      const liveBouncePct = current.bounceCount / current.sentCount;
      if (liveBouncePct > 0.05) {
        await withTenant(apiKeyId, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'paused_bounce' } }));
        logger.warn({ campaignId, bouncePct: liveBouncePct }, 'Campaign auto-paused: bounce rate exceeded 5%');
        void dispatchWebhook({
          apiKeyId,
          event: 'campaign.paused_bounce',
          eventId: buildEventId('campaign.paused_bounce', campaignId),
          payload: { event: 'campaign.paused_bounce', campaign_id: campaignId, bounce_pct: liveBouncePct, apiVersion: '2' as const },
        }).catch(() => {});
        stoppedEarly = true;
        break;
      }
    }

    // Every other send surface (/v1/send, batch send, sequence steps) is
    // gated on the key's monthly send quota — campaigns were the one path
    // that could blow straight through it, since sends here never went
    // through requireMonthlySendQuota (that's an HTTP preHandler; this is a
    // background worker with no request/reply to hang it on) or incremented
    // usage at all. Re-read fresh each chunk, same reasoning as the
    // suppression re-check below: a campaign can run for minutes, long
    // enough for other sending activity on this key to change what's left.
    const apiKeyRow = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { plan: true, monthlySendLimit: true, currentMonthSendUsage: true },
    });
    const sendLimit = getSendLimit(apiKeyRow?.plan ?? null, apiKeyRow?.monthlySendLimit);
    const sendRemaining = Math.max(0, sendLimit - (apiKeyRow?.currentMonthSendUsage ?? 0));
    if (sendRemaining <= 0) {
      await withTenant(apiKeyId, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'paused_quota' } }));
      logger.warn({ campaignId, apiKeyId }, 'Campaign auto-paused: monthly send quota exhausted');
      void dispatchWebhook({
        apiKeyId,
        event: 'campaign.paused_quota',
        eventId: buildEventId('campaign.paused_quota', campaignId),
        payload: { event: 'campaign.paused_quota', campaign_id: campaignId, apiVersion: '2' as const },
      }).catch(() => {});
      stoppedEarly = true;
      break;
    }

    let chunk = validRecipients.slice(i, i + CHUNK_SIZE).slice(0, sendRemaining);

    // Re-check suppression per chunk, not just once at campaign start — a
    // large list can take minutes to send, and someone who unsubscribes or
    // bounces on a completely different channel (a reply to a transactional
    // email, a different campaign) partway through must not still get a
    // later chunk just because they weren't suppressed yet when this
    // campaign began.
    if (i > 0) {
      // withRlsBypass, not withTenant: Suppression is deliberately global
      // (see schema.prisma) — not scoped by apiKeyId.
      const freshlySuppressed = await withRlsBypass((tx) => tx.suppression.findMany({
        where: { email: { in: chunk.map(r => r.email) } },
        select: { email: true },
      }));
      if (freshlySuppressed.length > 0) {
        const freshSet = new Set(freshlySuppressed.map(s => s.email));
        await withTenant(apiKeyId, (tx) => tx.campaignRecipient.updateMany({
          where: { campaignId, email: { in: [...freshSet] } },
          data: { status: 'suppressed' },
        })).catch(() => {});
        chunk = chunk.filter(r => !freshSet.has(r.email));
      }
    }

    const sentBeforeChunk = sentCount;
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

        const sendResult = await sendViaTransportWithFallback({
          to: recipient.email, from: fromAddress, subject,
          htmlBody,
          ...(textBody ? { textBody } : {}),
          ...(campaign.replyTo ? { replyTo: campaign.replyTo } : {}),
          listUnsubscribeHeader: `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`,
        }, { allowFallback, logCtx: { campaignId, email: recipient.email } });

        if (!sendResult.ok) throw new Error(sendResult.errorMessage);
        const { sesMessageId, smtp2goMessageId } = sendResult;

        await withTenant(apiKeyId, (tx) => tx.campaignRecipient.updateMany({
          where: { campaignId, email: recipient.email },
          // campaign_recipients has no smtp2goMessageId column — sesMessageId
          // stays null on an SMTP2GO-fallback send here (informational field
          // only). Real bounce/complaint correlation runs through the
          // SendMessage row below, which does carry both ids.
          data: { status: 'sent', sesMessageId, sentAt: new Date(), variant: recipientVariant },
        }));

        // Also register this send as a SendMessage row — the bounce/
        // complaint webhooks (POST /v1/send/events for SES, POST
        // /v1/send/smtp2go-events/:token for SMTP2GO) only know how to match
        // an incoming notification back to a SendMessage row by message id.
        // Without this, campaign bounces had nowhere to land: no automatic
        // suppression, no closed-loop verification correction, nothing —
        // the recipient stayed fully sendable in every future campaign and
        // sequence despite having just hard-bounced.
        await withTenant(apiKeyId, (tx) => tx.sendMessage.create({
          data: {
            apiKeyId, to: recipient.email, from: fromAddress, subject,
            sesMessageId, smtp2goMessageId, status: 'sent', sentAt: new Date(),
            // Store the tracking token so the open/click pixel can find this
            // row — the SendMessage id is a cuid and the tracking token uses
            // campaignId_email, so without this the campaign open/click
            // counts can never be incremented.
            trackingToken: trackingId,
          },
        })).catch((err) => {
          logger.warn({ err, email: recipient.email, campaignId }, 'Failed to register campaign send for bounce tracking (non-fatal)');
        });

        sentCount++;
      } catch (err) {
        logger.error({ err, email: recipient.email, campaignId }, 'Campaign send to recipient failed');
        await withTenant(apiKeyId, (tx) => tx.campaignRecipient.updateMany({
          where: { campaignId, email: recipient.email },
          data: { status: 'failed' },
        }));
      }
    }));

    // Update progress
    await withTenant(apiKeyId, (tx) => tx.campaign.update({ where: { id: campaignId }, data: { sentCount } }));
    void incrementSendUsageBy(apiKeyId, sentCount - sentBeforeChunk);

    // Inter-chunk delay: honour drip rate if set, else 100ms to stay under SES burst limit.
    // sendRatePerHour = 300 → max 300 emails/hr → 50-email chunk every 600s.
    if (i + CHUNK_SIZE < validRecipients.length) {
      const rate = (campaign as unknown as { sendRatePerHour: number | null }).sendRatePerHour;
      const delayMs = rate && rate > 0
        ? Math.max(100, (CHUNK_SIZE / rate) * 3_600_000)
        : 100;
      await new Promise(r => setTimeout(r, delayMs));

      // Respect send window — if outside allowed days/hours, wait up to 15min then recheck.
      // This blocks the worker thread, which is acceptable: a campaign that chose a send window
      // can occupy a slot during off-hours. Worker concurrency handles other campaigns.
      const sendDays = campaign.sendDays as string[];
      if (sendDays && sendDays.length > 0) {
        while (!isInSendWindow(campaign)) {
          logger.info({ campaignId, timezone: campaign.timezone }, 'Campaign outside send window — waiting 15min');
          await new Promise(r => setTimeout(r, 15 * 60 * 1000));
          // Re-check cancellation
          const recheck = await withTenant(apiKeyId, (tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
          if (recheck?.status === 'cancelled') {
            logger.info({ campaignId }, 'Campaign cancelled while waiting for send window');
            return;
          }
        }
      }
    }
  }

  if (stoppedEarly) {
    logger.info({ campaignId, sentCount, total: validRecipients.length }, 'Campaign send stopped early (cancelled/paused) — leaving status as set above');
    return;
  }

  const finalCampaign = await withTenant(apiKeyId, (tx) => tx.campaign.update({
    where: { id: campaignId },
    data: { status: 'sent', sentAt: new Date(), sentCount },
    select: { id: true, name: true, subject: true, fromEmail: true, totalRecipients: true, sentCount: true, sentAt: true },
  }));

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

  // Required: without this, BullMQ 'error' events (Redis blips, stalled-job
  // check failures) become uncaughtExceptions that kill the whole process.
  worker.on('error', (err) => {
    logger.error({ err }, 'Campaign worker error (non-fatal)');
  });

  return worker;
}

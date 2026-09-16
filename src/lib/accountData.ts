/**
 * Account data export and deletion — backs the DPA's "on termination,
 * delete or return Customer personal data within 30 days" commitment
 * (continuum-web /legal/dpa). Before this, that promise had no technical
 * mechanism behind it at all: no export endpoint, no deletion endpoint.
 *
 * Deletion order matters: several tables reference an apiKeyId-owned
 * parent without `onDelete: Cascade` in prisma/schema.prisma (ReplyEvent →
 * Mailbox/SequenceEnrollment, MonitorCheck → Monitor, WebhookDelivery →
 * Webhook, SendMessage → Verification, Verification → BulkJob,
 * AutomationEnrollment → Automation), so those children must be deleted
 * before their parent or the transaction fails on a foreign-key
 * violation. Tables with `onDelete: Cascade` (BulkJobEmail, SendEvent,
 * WebhookAttempt, WarmupConfig, ContactListMembership, SequenceStep,
 * SequenceEnrollment, AutomationStep, CampaignRecipient, and the implicit
 * Campaign<->MailingList/Segment join tables) are cleaned up by Postgres
 * automatically and are not listed here.
 *
 * Deliberately EXCLUDED from both export and deletion:
 *   - Suppression: a platform-wide bounce/complaint/opt-out safety list
 *     (apiKeyId is nullable — "who caused this," not "who owns this").
 *     Deleting it on account closure would let someone else re-email an
 *     address that already bounced or complained.
 *   - SoftBounceTrack: same shape and same reasoning as Suppression.
 *   - SequenceTemplate: a shared curated library, not tenant data (has no
 *     apiKeyId field at all).
 */

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { withTenant, type PrismaTx } from './tenantContext.js';

interface OwnedIds {
  mailboxIds: string[];
  monitorIds: string[];
  webhookIds: string[];
  automationIds: string[];
  campaignIds: string[];
  sequenceIds: string[];
  sendMessageIds: string[];
}

// Takes `tx` rather than opening its own transaction — every caller already
// has one open via withTenant (RLS-covered models here — mailbox, campaign,
// sequence, sendMessage — need that scope), and Prisma doesn't support
// nested transactions. monitor/webhook/automation aren't RLS-covered, so
// they stay on the plain `prisma` client even though they run alongside
// tx-scoped calls in the same Promise.all.
async function collectOwnedIds(tx: PrismaTx, apiKeyId: string): Promise<OwnedIds> {
  const [mailboxes, monitors, webhooks, automations, campaigns, sequences, sendMessages] = await Promise.all([
    tx.mailbox.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.monitor.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.webhook.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.automation.findMany({ where: { apiKeyId }, select: { id: true } }),
    tx.campaign.findMany({ where: { apiKeyId }, select: { id: true } }),
    tx.sequence.findMany({ where: { apiKeyId }, select: { id: true } }),
    tx.sendMessage.findMany({ where: { apiKeyId }, select: { id: true } }),
  ]);
  return {
    mailboxIds: mailboxes.map((r) => r.id),
    monitorIds: monitors.map((r) => r.id),
    webhookIds: webhooks.map((r) => r.id),
    automationIds: automations.map((r) => r.id),
    campaignIds: campaigns.map((r) => r.id),
    sequenceIds: sequences.map((r) => r.id),
    sendMessageIds: sendMessages.map((r) => r.id),
  };
}


export async function exportAccountData(apiKeyId: string): Promise<Record<string, unknown>> {
  return withTenant(apiKeyId, async (tx) => {
    const ids = await collectOwnedIds(tx, apiKeyId);

    const [
      mailboxes, monitors, webhooks, automations, campaigns, sequences,
      sendMessages, verifications, bulkJobs, contacts, mailingLists,
      segments, sendingDomains, emailTemplates, leads, inboxTests,
      replyEvents, trackingEvents, monitorChecks, webhookDeliveries,
      automationEnrollments,
    ] = await Promise.all([
      tx.mailbox.findMany({ where: { apiKeyId } }),
      prisma.monitor.findMany({ where: { apiKeyId } }),
      prisma.webhook.findMany({ where: { apiKeyId } }),
      prisma.automation.findMany({ where: { apiKeyId } }),
      tx.campaign.findMany({ where: { apiKeyId } }),
      tx.sequence.findMany({ where: { apiKeyId } }),
      tx.sendMessage.findMany({ where: { apiKeyId } }),
      prisma.verification.findMany({ where: { apiKeyId } }),
      prisma.bulkJob.findMany({ where: { apiKeyId } }),
      tx.contact.findMany({ where: { apiKeyId } }),
      tx.mailingList.findMany({ where: { apiKeyId } }),
      tx.segment.findMany({ where: { apiKeyId } }),
      prisma.sendingDomain.findMany({ where: { apiKeyId } }),
      prisma.emailTemplate.findMany({ where: { apiKeyId } }),
      tx.lead.findMany({ where: { apiKeyId } }),
      prisma.inboxTest.findMany({ where: { apiKeyId } }),
      tx.replyEvent.findMany({ where: { mailboxId: { in: ids.mailboxIds } } }),
      prisma.trackingEvent.findMany({
        where: { OR: [{ sendMessageId: { in: ids.sendMessageIds } }, { campaignId: { in: ids.campaignIds } }, { sequenceId: { in: ids.sequenceIds } }] },
      }),
      prisma.monitorCheck.findMany({ where: { monitorId: { in: ids.monitorIds } } }),
      prisma.webhookDelivery.findMany({ where: { webhookId: { in: ids.webhookIds } } }),
      // tenant-sweep: automationIds itself came from an apiKeyId-scoped query
      // above (collectOwnedIds) — this is a two-hop scope, not unscoped.
      prisma.automationEnrollment.findMany({ where: { automationId: { in: ids.automationIds } } }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      apiKeyId,
      data: {
        mailboxes, monitors, webhooks, automations, campaigns, sequences,
        sendMessages, verifications, bulkJobs, contacts, mailingLists,
        segments, sendingDomains, emailTemplates, leads, inboxTests,
        replyEvents, trackingEvents, monitorChecks, webhookDeliveries,
        automationEnrollments,
      },
    };
  });
}

export async function deleteAccountData(apiKeyId: string): Promise<Record<string, number>> {
  return withTenant(apiKeyId, async (tx) => {
    const ids = await collectOwnedIds(tx, apiKeyId);

    // [label, thunk] pairs, in the exact order they must run — children of
    // a non-cascading apiKeyId-owned parent before that parent (see the
    // module doc comment above for which relations force this). Run as
    // sequential awaits on the same `tx` (already one atomic transaction
    // via withTenant) rather than prisma.$transaction(array) — Prisma
    // doesn't support nesting a second transaction inside this one, and
    // sequential awaits on one tx give the identical atomicity and
    // ordering guarantee the original array form did. Labels stay paired
        // with their call here so the result counts can never be zipped back
    // to the wrong table by an out-of-sync separate list.
    const steps: [string, () => ReturnType<PrismaTx['replyEvent']['deleteMany']>][] = [
      ['replyEvents', () => tx.replyEvent.deleteMany({ where: { mailboxId: { in: ids.mailboxIds } } })],
      ['trackingEvents', () => prisma.trackingEvent.deleteMany({
        where: { OR: [{ sendMessageId: { in: ids.sendMessageIds } }, { campaignId: { in: ids.campaignIds } }, { sequenceId: { in: ids.sequenceIds } }] },
      })],
      ['monitorChecks', () => prisma.monitorCheck.deleteMany({ where: { monitorId: { in: ids.monitorIds } } })],
      ['webhookDeliveries', () => prisma.webhookDelivery.deleteMany({ where: { webhookId: { in: ids.webhookIds } } })],
      ['sendMessages', () => tx.sendMessage.deleteMany({ where: { apiKeyId } })],
      ['verifications', () => prisma.verification.deleteMany({ where: { apiKeyId } })],
      ['bulkJobs', () => prisma.bulkJob.deleteMany({ where: { apiKeyId } })],
      ['automationEnrollments', () => prisma.automationEnrollment.deleteMany({ where: { automationId: { in: ids.automationIds } } })],
      ['automations', () => prisma.automation.deleteMany({ where: { apiKeyId } })],
      ['campaigns', () => tx.campaign.deleteMany({ where: { apiKeyId } })],
      ['sequences', () => tx.sequence.deleteMany({ where: { apiKeyId } })],
      ['mailboxes', () => tx.mailbox.deleteMany({ where: { apiKeyId } })],
      ['contacts', () => tx.contact.deleteMany({ where: { apiKeyId } })],
      ['mailingLists', () => tx.mailingList.deleteMany({ where: { apiKeyId } })],
      ['segments', () => tx.segment.deleteMany({ where: { apiKeyId } })],
      ['sendingDomains', () => prisma.sendingDomain.deleteMany({ where: { apiKeyId } })],
      ['emailTemplates', () => prisma.emailTemplate.deleteMany({ where: { apiKeyId } })],
      ['leads', () => tx.lead.deleteMany({ where: { apiKeyId } })],
      ['inboxTests', () => prisma.inboxTest.deleteMany({ where: { apiKeyId } })],
      // Last among their own children — nothing else still points at these.
      ['webhooks', () => prisma.webhook.deleteMany({ where: { apiKeyId } })],
      ['monitors', () => prisma.monitor.deleteMany({ where: { apiKeyId } })],
    ];

    const counts: Record<string, number> = {};
    for (const [label, run] of steps) {
      const result = await run();
      counts[label] = result.count ?? 0;
    }

    logger.info({ apiKeyId, counts }, 'Account data deleted');
    return counts;
  });
}

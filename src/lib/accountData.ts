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

interface OwnedIds {
  mailboxIds: string[];
  monitorIds: string[];
  webhookIds: string[];
  automationIds: string[];
  campaignIds: string[];
  sequenceIds: string[];
  sendMessageIds: string[];
}

async function collectOwnedIds(apiKeyId: string): Promise<OwnedIds> {
  const [mailboxes, monitors, webhooks, automations, campaigns, sequences, sendMessages] = await Promise.all([
    prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.monitor.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.webhook.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.automation.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.campaign.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.sequence.findMany({ where: { apiKeyId }, select: { id: true } }),
    prisma.sendMessage.findMany({ where: { apiKeyId }, select: { id: true } }),
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
  const ids = await collectOwnedIds(apiKeyId);

  const [
    mailboxes, monitors, webhooks, automations, campaigns, sequences,
    sendMessages, verifications, bulkJobs, contacts, mailingLists,
    segments, sendingDomains, emailTemplates, leads, inboxTests,
    replyEvents, trackingEvents, monitorChecks, webhookDeliveries,
    automationEnrollments,
  ] = await Promise.all([
    prisma.mailbox.findMany({ where: { apiKeyId } }),
    prisma.monitor.findMany({ where: { apiKeyId } }),
    prisma.webhook.findMany({ where: { apiKeyId } }),
    prisma.automation.findMany({ where: { apiKeyId } }),
    prisma.campaign.findMany({ where: { apiKeyId } }),
    prisma.sequence.findMany({ where: { apiKeyId } }),
    prisma.sendMessage.findMany({ where: { apiKeyId } }),
    prisma.verification.findMany({ where: { apiKeyId } }),
    prisma.bulkJob.findMany({ where: { apiKeyId } }),
    prisma.contact.findMany({ where: { apiKeyId } }),
    prisma.mailingList.findMany({ where: { apiKeyId } }),
    prisma.segment.findMany({ where: { apiKeyId } }),
    prisma.sendingDomain.findMany({ where: { apiKeyId } }),
    prisma.emailTemplate.findMany({ where: { apiKeyId } }),
    prisma.lead.findMany({ where: { apiKeyId } }),
    prisma.inboxTest.findMany({ where: { apiKeyId } }),
    prisma.replyEvent.findMany({ where: { mailboxId: { in: ids.mailboxIds } } }),
    prisma.trackingEvent.findMany({
      where: { OR: [{ sendMessageId: { in: ids.sendMessageIds } }, { campaignId: { in: ids.campaignIds } }, { sequenceId: { in: ids.sequenceIds } }] },
    }),
    prisma.monitorCheck.findMany({ where: { monitorId: { in: ids.monitorIds } } }),
    prisma.webhookDelivery.findMany({ where: { webhookId: { in: ids.webhookIds } } }),
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
}

export async function deleteAccountData(apiKeyId: string): Promise<Record<string, number>> {
  const ids = await collectOwnedIds(apiKeyId);

  // [label, deleteMany call] pairs, in the exact order they must run —
  // children of a non-cascading apiKeyId-owned parent before that parent
  // (see the module doc comment above for which relations force this).
  // Labels stay paired with their call here so the result counts can never
  // be zipped back to the wrong table by an out-of-sync separate list.
  const steps: [string, ReturnType<typeof prisma.replyEvent.deleteMany>][] = [
    ['replyEvents', prisma.replyEvent.deleteMany({ where: { mailboxId: { in: ids.mailboxIds } } })],
    ['trackingEvents', prisma.trackingEvent.deleteMany({
      where: { OR: [{ sendMessageId: { in: ids.sendMessageIds } }, { campaignId: { in: ids.campaignIds } }, { sequenceId: { in: ids.sequenceIds } }] },
    })],
    ['monitorChecks', prisma.monitorCheck.deleteMany({ where: { monitorId: { in: ids.monitorIds } } })],
    ['webhookDeliveries', prisma.webhookDelivery.deleteMany({ where: { webhookId: { in: ids.webhookIds } } })],
    ['sendMessages', prisma.sendMessage.deleteMany({ where: { apiKeyId } })],
    ['verifications', prisma.verification.deleteMany({ where: { apiKeyId } })],
    ['bulkJobs', prisma.bulkJob.deleteMany({ where: { apiKeyId } })],
    ['automationEnrollments', prisma.automationEnrollment.deleteMany({ where: { automationId: { in: ids.automationIds } } })],
    ['automations', prisma.automation.deleteMany({ where: { apiKeyId } })],
    ['campaigns', prisma.campaign.deleteMany({ where: { apiKeyId } })],
    ['sequences', prisma.sequence.deleteMany({ where: { apiKeyId } })],
    ['mailboxes', prisma.mailbox.deleteMany({ where: { apiKeyId } })],
    ['contacts', prisma.contact.deleteMany({ where: { apiKeyId } })],
    ['mailingLists', prisma.mailingList.deleteMany({ where: { apiKeyId } })],
    ['segments', prisma.segment.deleteMany({ where: { apiKeyId } })],
    ['sendingDomains', prisma.sendingDomain.deleteMany({ where: { apiKeyId } })],
    ['emailTemplates', prisma.emailTemplate.deleteMany({ where: { apiKeyId } })],
    ['leads', prisma.lead.deleteMany({ where: { apiKeyId } })],
    ['inboxTests', prisma.inboxTest.deleteMany({ where: { apiKeyId } })],
    // Last among their own children — nothing else still points at these.
    ['webhooks', prisma.webhook.deleteMany({ where: { apiKeyId } })],
    ['monitors', prisma.monitor.deleteMany({ where: { apiKeyId } })],
  ];

  const results = await prisma.$transaction(steps.map(([, call]) => call));

  const counts: Record<string, number> = {};
  steps.forEach(([label], i) => { counts[label] = results[i]?.count ?? 0; });

  logger.info({ apiKeyId, counts }, 'Account data deleted');
  return counts;
}

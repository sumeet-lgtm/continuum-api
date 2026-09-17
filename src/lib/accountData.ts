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
// has one open via withTenant, and Prisma doesn't support nested
// transactions. All models queried here are RLS-covered (as of the
// 2026-09-17 hardening pass, that now includes monitor/webhook/automation
// too), so every call in this file must go through `tx`, never the plain
// `prisma` client — a plain-client call silently returns zero rows once
// RLS is actually enforced (see tenantContext.ts's "deny by default" note).
async function collectOwnedIds(tx: PrismaTx, apiKeyId: string): Promise<OwnedIds> {
  const [mailboxes, monitors, webhooks, automations, campaigns, sequences, sendMessages] =
    await Promise.all([
      tx.mailbox.findMany({ where: { apiKeyId }, select: { id: true } }),
      tx.monitor.findMany({ where: { apiKeyId }, select: { id: true } }),
      tx.webhook.findMany({ where: { apiKeyId }, select: { id: true } }),
      tx.automation.findMany({ where: { apiKeyId }, select: { id: true } }),
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

// Export is read-only and doesn't need the cross-table atomicity
// deleteAccountData genuinely requires (a GDPR export tolerates a snapshot
// taken across a few hundred ms, not a single instant) — so unlike
// deleteAccountData, this does NOT share one withTenant transaction across
// every query. Discovered live: with ~28 queries, one shared transaction
// puts them all on a single pooled connection (Promise.all inside one tx
// does not run them concurrently at the DB level — Prisma pipelines them
// on that one connection), and against Supabase's pooler that serialized
// round-trip time exceeded Prisma's 5s interactive-transaction timeout,
// so exportAccountData 500'd for every real customer once RLS made the
// query correctly hit real data instead of returning early. Each query
// below gets its own withTenant call (its own connection), so they run
// genuinely in parallel and each gets its own timeout budget.
async function collectOwnedIdsParallel(apiKeyId: string): Promise<OwnedIds> {
  const [mailboxes, monitors, webhooks, automations, campaigns, sequences, sendMessages] =
    await Promise.all([
      withTenant(apiKeyId, (tx) =>
        tx.mailbox.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.monitor.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.webhook.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.automation.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.campaign.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.sequence.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
      withTenant(apiKeyId, (tx) =>
        tx.sendMessage.findMany({ where: { apiKeyId }, select: { id: true } }),
      ),
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
  const ids = await collectOwnedIdsParallel(apiKeyId);

  const [
    mailboxes,
    monitors,
    webhooks,
    automations,
    campaigns,
    sequences,
    sendMessages,
    verifications,
    bulkJobs,
    contacts,
    mailingLists,
    segments,
    sendingDomains,
    emailTemplates,
    leads,
    inboxTests,
    replyEvents,
    trackingEvents,
    monitorChecks,
    webhookDeliveries,
    automationEnrollments,
  ] = await Promise.all([
    withTenant(apiKeyId, (tx) => tx.mailbox.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.monitor.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.webhook.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.automation.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.campaign.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.sequence.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.sendMessage.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.verification.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.bulkJob.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.contact.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.mailingList.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.segment.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.sendingDomain.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.emailTemplate.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.lead.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) => tx.inboxTest.findMany({ where: { apiKeyId } })),
    withTenant(apiKeyId, (tx) =>
      tx.replyEvent.findMany({ where: { mailboxId: { in: ids.mailboxIds } } }),
    ),
    withTenant(apiKeyId, (tx) =>
      tx.trackingEvent.findMany({
        where: {
          OR: [
            { sendMessageId: { in: ids.sendMessageIds } },
            { campaignId: { in: ids.campaignIds } },
            { sequenceId: { in: ids.sequenceIds } },
          ],
        },
      }),
    ),
    withTenant(apiKeyId, (tx) =>
      tx.monitorCheck.findMany({ where: { monitorId: { in: ids.monitorIds } } }),
    ),
    withTenant(apiKeyId, (tx) =>
      tx.webhookDelivery.findMany({ where: { webhookId: { in: ids.webhookIds } } }),
    ),
    // tenant-sweep: automationIds itself came from an apiKeyId-scoped query
    // above (collectOwnedIdsParallel) — this is a two-hop scope, not unscoped.
    withTenant(apiKeyId, (tx) =>
      tx.automationEnrollment.findMany({ where: { automationId: { in: ids.automationIds } } }),
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    apiKeyId,
    data: {
      mailboxes,
      monitors,
      webhooks,
      automations,
      campaigns,
      sequences,
      sendMessages,
      verifications,
      bulkJobs,
      contacts,
      mailingLists,
      segments,
      sendingDomains,
      emailTemplates,
      leads,
      inboxTests,
      replyEvents,
      trackingEvents,
      monitorChecks,
      webhookDeliveries,
      automationEnrollments,
    },
  };
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
      [
        'replyEvents',
        () => tx.replyEvent.deleteMany({ where: { mailboxId: { in: ids.mailboxIds } } }),
      ],
      [
        'trackingEvents',
        () =>
          tx.trackingEvent.deleteMany({
            where: {
              OR: [
                { sendMessageId: { in: ids.sendMessageIds } },
                { campaignId: { in: ids.campaignIds } },
                { sequenceId: { in: ids.sequenceIds } },
              ],
            },
          }),
      ],
      [
        'monitorChecks',
        () => tx.monitorCheck.deleteMany({ where: { monitorId: { in: ids.monitorIds } } }),
      ],
      [
        'webhookDeliveries',
        () => tx.webhookDelivery.deleteMany({ where: { webhookId: { in: ids.webhookIds } } }),
      ],
      ['sendMessages', () => tx.sendMessage.deleteMany({ where: { apiKeyId } })],
      ['verifications', () => tx.verification.deleteMany({ where: { apiKeyId } })],
      ['bulkJobs', () => tx.bulkJob.deleteMany({ where: { apiKeyId } })],
      [
        'automationEnrollments',
        () =>
          tx.automationEnrollment.deleteMany({
            where: { automationId: { in: ids.automationIds } },
          }),
      ],
      ['automations', () => tx.automation.deleteMany({ where: { apiKeyId } })],
      ['campaigns', () => tx.campaign.deleteMany({ where: { apiKeyId } })],
      ['sequences', () => tx.sequence.deleteMany({ where: { apiKeyId } })],
      ['mailboxes', () => tx.mailbox.deleteMany({ where: { apiKeyId } })],
      ['contacts', () => tx.contact.deleteMany({ where: { apiKeyId } })],
      ['mailingLists', () => tx.mailingList.deleteMany({ where: { apiKeyId } })],
      ['segments', () => tx.segment.deleteMany({ where: { apiKeyId } })],
      ['sendingDomains', () => tx.sendingDomain.deleteMany({ where: { apiKeyId } })],
      ['emailTemplates', () => tx.emailTemplate.deleteMany({ where: { apiKeyId } })],
      ['leads', () => tx.lead.deleteMany({ where: { apiKeyId } })],
      ['inboxTests', () => tx.inboxTest.deleteMany({ where: { apiKeyId } })],
      // Last among their own children — nothing else still points at these.
      ['webhooks', () => tx.webhook.deleteMany({ where: { apiKeyId } })],
      ['monitors', () => tx.monitor.deleteMany({ where: { apiKeyId } })],
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

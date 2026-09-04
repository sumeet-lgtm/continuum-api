import { Worker, type Job } from 'bullmq';
import { QUEUE_SALESFORCE_SYNC, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { decryptValue } from '../lib/crypto.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getSalesforceAccessToken } from '../lib/oauth/salesforce.js';
import { findLeadByEmail, createLead, updateLead, logActivity, queryLeadsById, SalesforceApiError } from '../lib/salesforceApi.js';

interface SalesforceSyncTickPayload {
  tick: true;
}

function getSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

// Leads without a real company name still hit Salesforce's required
// Company field — falling back to the email's domain (capitalized) reads
// far better in the SFDC UI than leaving it blank, which the API rejects
// outright rather than defaulting for you.
function fallbackCompany(email: string, company: string | null): string {
  if (company?.trim()) return company.trim();
  const domain = email.split('@')[1] ?? 'Unknown';
  return domain.split('.')[0]!.replace(/^\w/, (c) => c.toUpperCase());
}

async function pushLeadsForConnection(
  apiKeyId: string,
  instanceUrl: string,
  accessToken: string,
): Promise<{ pushed: number; errors: number }> {
  const existingSyncs = await prisma.salesforceLeadSync.findMany({ where: { apiKeyId } });
  const syncedByEmail = new Map(existingSyncs.map((s) => [s.leadEmail, s]));

  // New leads (never synced) + leads updated since their last push.
  const candidates = await prisma.lead.findMany({
    where: {
      apiKeyId,
      OR: [
        { email: { notIn: [...syncedByEmail.keys()] } },
        ...(existingSyncs.length > 0
          ? [{ email: { in: [...syncedByEmail.keys()] }, updatedAt: { gt: new Date(Math.min(...existingSyncs.map((s) => s.lastPushedAt.getTime()))) } }]
          : []),
      ],
    },
    take: 200,
  });

  let pushed = 0;
  let errors = 0;

  for (const lead of candidates) {
    const existingSync = syncedByEmail.get(lead.email);
    // A lead already synced but not actually stale (updatedAt didn't move
    // past ITS OWN lastPushedAt — the batch OR above is a coarse min-based
    // filter, not per-row) doesn't need re-pushing.
    if (existingSync && lead.updatedAt <= existingSync.lastPushedAt) continue;

    try {
      const fields = {
        Email: lead.email,
        FirstName: lead.firstName ?? undefined,
        LastName: lead.lastName?.trim() || '(Unknown)',
        Company: fallbackCompany(lead.email, lead.company),
        Title: lead.title ?? undefined,
        LeadSource: 'Continuum',
      };

      let salesforceId = existingSync?.salesforceId ?? null;
      if (salesforceId) {
        await updateLead(instanceUrl, accessToken, salesforceId, fields);
      } else {
        // Even for a "new" local lead, it may already exist in Salesforce
        // (added by a rep, or synced from an earlier connection) — check
        // before creating, so reconnecting or re-running never duplicates.
        const found = await findLeadByEmail(instanceUrl, accessToken, lead.email);
        salesforceId = found?.id ?? await createLead(instanceUrl, accessToken, fields);
      }

      await prisma.salesforceLeadSync.upsert({
        where: { apiKeyId_leadEmail: { apiKeyId, leadEmail: lead.email } },
        create: { apiKeyId, leadEmail: lead.email, salesforceId, sfObjectType: 'Lead' },
        update: { salesforceId, lastPushedAt: new Date() },
      });
      pushed++;
    } catch (err) {
      errors++;
      const detail = err instanceof SalesforceApiError ? `${err.status}: ${err.message}` : String(err);
      logger.error({ err: detail, apiKeyId, email: lead.email }, 'Salesforce lead push failed');
    }
  }

  return { pushed, errors };
}

async function pushRepliesForConnection(
  apiKeyId: string,
  instanceUrl: string,
  accessToken: string,
  since: Date | null,
): Promise<number> {
  const mailboxIds = (await prisma.mailbox.findMany({ where: { apiKeyId }, select: { id: true } })).map((m) => m.id);
  if (mailboxIds.length === 0) return 0;

  const replies = await prisma.replyEvent.findMany({
    where: {
      mailboxId: { in: mailboxIds },
      receivedAt: since ? { gt: since } : undefined,
    },
    orderBy: { receivedAt: 'asc' },
    take: 200,
  });
  if (replies.length === 0) return 0;

  const syncs = await prisma.salesforceLeadSync.findMany({
    where: { apiKeyId, leadEmail: { in: [...new Set(replies.map((r) => r.fromEmail))] } },
  });
  const syncByEmail = new Map(syncs.map((s) => [s.leadEmail, s]));

  let logged = 0;
  for (const reply of replies) {
    const sync = syncByEmail.get(reply.fromEmail);
    if (!sync) continue; // lead not pushed to SFDC (yet) — nothing to attach the activity to
    try {
      await logActivity(
        instanceUrl,
        accessToken,
        sync.salesforceId,
        `Reply: ${reply.subject ?? '(no subject)'}`,
        reply.bodySnippet ?? '(no preview available)',
      );
      logged++;
    } catch (err) {
      const detail = err instanceof SalesforceApiError ? `${err.status}: ${err.message}` : String(err);
      logger.error({ err: detail, apiKeyId, email: reply.fromEmail }, 'Salesforce activity log failed');
    }
  }
  return logged;
}

// Statuses a Salesforce rep would set to say "stop contacting this person" —
// synced back so Continuum's own sequences respect a decision made on the
// SFDC side instead of continuing to email someone the rep already
// disqualified or converted.
const SF_STOP_STATUSES = new Set(['unqualified', 'disqualified', 'closed', 'do not contact', 'converted']);

async function pullStatusForConnection(apiKeyId: string, instanceUrl: string, accessToken: string): Promise<number> {
  const syncs = await prisma.salesforceLeadSync.findMany({ where: { apiKeyId, sfObjectType: 'Lead' }, take: 200 });
  if (syncs.length === 0) return 0;

  const records = await queryLeadsById(instanceUrl, accessToken, syncs.map((s) => s.salesforceId));
  const byId = new Map(records.map((r) => [r.Id, r]));

  let updated = 0;
  for (const sync of syncs) {
    const record = byId.get(sync.salesforceId);
    if (!record) continue;
    const statusChanged = record.Status !== sync.lastSfStatus;
    if (!statusChanged && !record.IsConverted) continue;

    await prisma.salesforceLeadSync.update({
      where: { id: sync.id },
      data: { lastSfStatus: record.Status, lastSfSyncedAt: new Date(), sfObjectType: record.IsConverted ? 'Contact' : 'Lead' },
    });

    const shouldStop = record.IsConverted || (record.Status && SF_STOP_STATUSES.has(record.Status.toLowerCase()));
    if (shouldStop) {
      await prisma.lead.updateMany({
        where: { apiKeyId, email: sync.leadEmail },
        data: { status: record.IsConverted ? 'converted' : 'do_not_contact' },
      }).catch(() => {});
      // Pause any sequence still actively emailing this address — a rep
      // marking a lead unqualified/converted in Salesforce should stop
      // Continuum's own outreach the same way an in-app status change would.
      await prisma.sequenceEnrollment.updateMany({
        where: { email: sync.leadEmail, status: 'active', sequence: { apiKeyId } },
        data: { status: 'paused' },
      }).catch(() => {});
    }
    updated++;
  }
  return updated;
}

export async function processSalesforceSyncTick(): Promise<void> {
  const connections = await prisma.salesforceConnection.findMany({ where: { syncEnabled: true } });

  for (const conn of connections) {
    try {
      const refreshToken = decryptValue(conn.refreshTokenEnc, getSecret());
      const accessToken = await getSalesforceAccessToken(refreshToken);

      const { pushed, errors } = await pushLeadsForConnection(conn.apiKeyId, conn.instanceUrl, accessToken);
      const logged = await pushRepliesForConnection(conn.apiKeyId, conn.instanceUrl, accessToken, conn.lastPushedAt);
      const pulled = await pullStatusForConnection(conn.apiKeyId, conn.instanceUrl, accessToken);

      logger.info({ apiKeyId: conn.apiKeyId, pushed, logged, pulled, errors }, 'Salesforce sync tick complete');

      await prisma.salesforceConnection.update({
        where: { id: conn.id },
        data: {
          lastPushedAt: new Date(),
          lastPulledAt: new Date(),
          lastErrorMsg: errors > 0 ? `${errors} lead(s) failed to sync — check logs` : null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Salesforce sync failed';
      logger.error({ err: message, apiKeyId: conn.apiKeyId }, 'Salesforce sync tick failed for connection');
      await prisma.salesforceConnection.update({ where: { id: conn.id }, data: { lastErrorMsg: message } }).catch(() => {});
    }
  }
}

export function startSalesforceSyncWorker(): Worker {
  const worker = new Worker<SalesforceSyncTickPayload>(
    QUEUE_SALESFORCE_SYNC,
    async (_job: Job<SalesforceSyncTickPayload>) => {
      await processSalesforceSyncTick();
    },
    { connection: redisConnection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Salesforce sync tick failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Salesforce sync worker error (non-fatal)');
  });

  return worker;
}

export async function scheduleSalesforceSyncTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 60 * 60 * 1000 }, // every hour
    jobId: 'salesforce-sync-tick-repeat',
  });
}

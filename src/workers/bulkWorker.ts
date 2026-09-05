/**
 * Bulk Verification Worker
 *
 * Consumes jobs from the `continuum:bulk` queue.
 * One job = one uploaded CSV file.
 *
 * Flow per job:
 *   1.  Mark BulkJob → processing, record startedAt
 *   2.  Download CSV from Supabase Storage
 *   3.  Re-parse CSV to get ordered email list (matches pre-created BulkJobEmail rows)
 *   4.  Skip duplicate rows (isDuplicate=true) — update their DB row immediately
 *   5.  Verify non-duplicate emails in parallel chunks (EMAIL_CONCURRENCY per chunk)
 *   6.  After each chunk: batch-update BulkJobEmail rows + flush aggregate counts to BulkJob
 *   7.  Build export CSV from all verified rows
 *   8.  Upload export CSV to Supabase Storage exports bucket
 *   9.  Mark BulkJob → completed
 *  10.  Dispatch bulk_job_complete webhooks
 *
 * On any unrecoverable error: mark BulkJob → failed with errorMessage.
 *
 * Stall recovery:
 *   If the process dies mid-job, BullMQ will reclaim the job after stalledInterval.
 *   The worker checks on startup whether any jobs are stuck in 'processing' and
 *   re-enqueues them via a recovery sweep.
 *
 * Concurrency:
 *   - 3 jobs processed simultaneously per worker process
 *   - 5 emails verified in parallel within each job
 *   - Progress flushed to DB every PROGRESS_FLUSH_INTERVAL emails
 */

import { Worker, Queue, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { redisConnection, QUEUE_BULK, webhookQueue } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { downloadFromStorage, uploadToStorage } from '../lib/supabase.js';
import { dispatchWebhook, buildEventId } from '../lib/webhooks.js';
import { verifyEmail } from '../engine/index.js';
import { incrementUsageBy } from '../plugins/usageMeter.js';
import { loadDisposableList } from '../engine/disposable.js';
import { parseCsv } from '../routes/bulk-jobs/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { initSentry, installCrashReporting } from '../lib/sentry.js';
import type { BulkJobPayload } from '../types/job.js';
import type { VerificationResult } from '../types/verification.js';

if (process.env['NODE_ENV'] !== 'test') {
  initSentry('worker-bulk');
  installCrashReporting('worker-bulk');
}

// This used to be capped at 4 solely because DeBounce rate-limits concurrent
// traffic (429s above ~4-5 in flight) — but that constraint only applies to
// the minority of emails that actually fall through to a paid provider. It
// was throttling every email in the job, including the free own-probe path
// that never calls DeBounce at all, which is why a 2,000-email list took
// ~40 minutes (0.8/sec) in production. The paid-provider rate limit is now
// enforced at its actual call site (paidProviderLimiter in smtpCache.ts,
// shared process-wide), so this can run at real concurrency.
const EMAIL_CONCURRENCY      = 20;
const PROGRESS_FLUSH_INTERVAL = 25;  // flush every N processed emails

// ─── Main job processor ───────────────────────────────────────────────────────

async function processBulkJob(job: Job<BulkJobPayload>): Promise<void> {
  const { jobId, apiKeyId, storagePath, fileName } = job.data;
  const log = logger.child({ jobId, fileName, worker: 'bulk' });

  log.info('Bulk job started');

  // ── 1. Mark as processing ──────────────────────────────────────────────────
  await prisma.bulkJob.update({
    where: { id: jobId },
    data:  { status: 'processing', startedAt: new Date() },
  });

  // ── 2. Download original CSV ───────────────────────────────────────────────
  let fileBuffer: Buffer;
  try {
    fileBuffer = await downloadFromStorage(config.STORAGE_BUCKET_UPLOADS, storagePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Storage download failed';
    log.error({ err }, 'CSV download failed');
    await failJob(jobId, msg);
    return;
  }

  // ── 3. Re-parse CSV to get the canonical email order ──────────────────────
  const parsed = parseCsv(fileBuffer.toString('utf-8'));

  if (parsed.length === 0) {
    await failJob(jobId, 'No email rows found in CSV after re-parsing');
    return;
  }

  // ── 4. Load pre-created BulkJobEmail rows (ordered by rowIndex) ───────────
  // We created these rows in the route handler. We use them to map results back.
  // Typed as mutable so the fallback branch can push into it
  // processedAt/status are read so a re-run RESUMES: rows already verified in a
  // previous attempt are skipped instead of re-charged and re-verified.
  type EmailRowRecord = { id: string; email: string; rowIndex: number; isDuplicate: boolean; processedAt: Date | null; status: string | null };
  const emailRows: EmailRowRecord[] = await prisma.bulkJobEmail.findMany({
    where:   { bulkJobId: jobId },
    orderBy: { rowIndex: 'asc' },
    select:  { id: true, email: true, rowIndex: true, isDuplicate: true, processedAt: true, status: true },
  });

  if (emailRows.length === 0) {
    // Primary path now: the creation route no longer pre-creates these rows
    // (that blew the 5s transaction timeout for big files), so the worker
    // builds them here. Batch at 500 — a single createMany of all rows would
    // exceed Postgres's 65k bound-parameter limit around ~13k rows.
    log.info({ rows: parsed.length }, 'Creating BulkJobEmail rows (batched)');
    const CREATE_BATCH = 500;
    for (let i = 0; i < parsed.length; i += CREATE_BATCH) {
      await prisma.bulkJobEmail.createMany({
        data: parsed.slice(i, i + CREATE_BATCH).map((r) => ({
          id:          randomUUID(),
          bulkJobId:   jobId,
          email:       r.email,
          rowIndex:    r.rowIndex,
          isDuplicate: r.isDuplicate,
        })),
      });
    }

    const refetched: EmailRowRecord[] = await prisma.bulkJobEmail.findMany({
      where:   { bulkJobId: jobId },
      orderBy: { rowIndex: 'asc' },
      select:  { id: true, email: true, rowIndex: true, isDuplicate: true, processedAt: true, status: true },
    });
    emailRows.push(...refetched);
  }

  // ── 5. Separate duplicates, already-done, and still-to-verify ─────────────
  // A previous attempt may have processed some rows (long jobs can be reclaimed
  // by BullMQ after a stall). Skip anything already verified so a 6-hour job
  // that blips resumes instead of restarting from zero.
  const dupeRows    = emailRows.filter((r) => r.isDuplicate);
  const dupeCount   = dupeRows.length;
  const alreadyDone = emailRows.filter((r) => !r.isDuplicate && r.processedAt);
  const toVerify    = emailRows.filter((r) => !r.isDuplicate && !r.processedAt);
  const totalToVerify = alreadyDone.length + toVerify.length;

  log.info({ total: emailRows.length, toVerify: toVerify.length, resumedDone: alreadyDone.length, duplicates: dupeCount },
    alreadyDone.length > 0 ? 'Resuming verification' : 'Starting verification');

  // ── 6. Verify emails with bounded per-job concurrency ─────────────────────
  // Seed running counts from rows completed in a previous attempt so progress
  // stays monotonic across a resume (never overwrites the DB with a lower count).
  let processedCount = alreadyDone.length;
  let validCount     = alreadyDone.filter((r) => r.status === 'valid').length;
  let invalidCount   = alreadyDone.filter((r) => r.status === 'invalid').length;
  let riskyCount     = alreadyDone.filter((r) => r.status === 'risky').length;
  let unknownCount   = alreadyDone.filter((r) => r.status === 'unknown').length;
  let errorCount     = alreadyDone.filter((r) => r.status === null).length;

  // Accumulate row updates to batch-write
  type RowUpdate = {
    id:             string;
    status:         string | null;
    subStatus:      string | null;
    score:          number | null;
    domain:         string | null;
    syntaxValid:    boolean | null;
    isDisposable:   boolean | null;
    isRoleAccount:  boolean | null;
    mxFound:        boolean | null;
    smtpChecked:    boolean | null;
    smtpReachable:  boolean | null;
    isCatchAll:     boolean | null;
    greylisted:     boolean;
    spfValid:       boolean | null;
    dkimFound:      boolean | null;
    dmarcValid:     boolean | null;
    blacklisted:    boolean | null;
    durationMs:     number | null;
    verificationId: string | null;
    errorMessage:   string | null;
    processedAt:    Date;
  };

  const rowUpdates: RowUpdate[] = [];

  for (let i = 0; i < toVerify.length; i += EMAIL_CONCURRENCY) {
    // Check for cancellation signal on each chunk
    const fresh = await prisma.bulkJob.findUnique({
      where:  { id: jobId },
      select: { status: true, cancelledAt: true },
    });
    if ((fresh?.status as string) === 'cancelled' || fresh?.cancelledAt) {
      log.info('Job cancelled — stopping processing');
      // Verifications already performed still count toward the monthly quota
      await incrementUsageBy(apiKeyId, processedCount);
      return;
    }

    const chunk = toVerify.slice(i, i + EMAIL_CONCURRENCY);

    const chunkSettled = await Promise.allSettled(
      chunk.map(async (row: typeof toVerify[number]) => {
        try {
          const result = await verifyEmail({
            email:     row.email,
            apiKeyId,
            bulkJobId: jobId,
            sourceIp:  undefined,
          });
          return { row, result, error: null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Engine error';
          return { row, result: null, error: msg };
        }
      }),
    );

    for (const settled of chunkSettled) {
      // Promise.allSettled never rejects when the fn is wrapped in try/catch
      // but the outer allSettled handles any remaining throws
      if (settled.status === 'rejected') {
        errorCount++;
        processedCount++;
        continue;
      }

      const { row, result, error } = (settled as PromiseFulfilledResult<typeof settled extends PromiseFulfilledResult<infer T> ? T : never>).value;
      processedCount++;

      if (error || !result) {
        errorCount++;
        rowUpdates.push({
          id:             row.id,
          status:         null,
          subStatus:      null,
          score:          null,
          domain:         null,
          syntaxValid:    null,
          isDisposable:   null,
          isRoleAccount:  null,
          mxFound:        null,
          smtpChecked:    null,
          smtpReachable:  null,
          isCatchAll:     null,
          greylisted:     false,
          spfValid:       null,
          dkimFound:      null,
          dmarcValid:     null,
          blacklisted:    null,
          durationMs:     null,
          verificationId: null,
          errorMessage:   error ?? 'Unknown error',
          processedAt:    new Date(),
        });
      } else {
        switch (result.status) {
          case 'valid':   validCount++;   break;
          case 'invalid': invalidCount++; break;
          case 'risky':   riskyCount++;   break;
          case 'unknown': unknownCount++; break;
        }

        rowUpdates.push({
          id:             row.id,
          status:         result.status,
          subStatus:      result.subStatus,
          score:          result.score,
          domain:         result.domain,
          syntaxValid:    result.checks.syntaxValid,
          isDisposable:   result.checks.isDisposable,
          isRoleAccount:  result.checks.isRoleAccount,
          mxFound:        result.checks.mxFound,
          smtpChecked:    result.checks.smtpChecked,
          smtpReachable:  result.checks.smtpReachable,
          isCatchAll:     result.checks.isCatchAll,
          greylisted:     result.checks.greylisted,
          spfValid:       result.checks.spfValid ?? null,
          dkimFound:      result.checks.dkimFound ?? null,
          dmarcValid:     result.checks.dmarcValid ?? null,
          blacklisted:    result.checks.blacklisted ?? null,
          durationMs:     result.durationMs,
          verificationId: result.id,
          errorMessage:   null,
          processedAt:    result.checkedAt,
        });
      }
    }

    // ── Flush to DB periodically ─────────────────────────────────────────────
    const shouldFlush =
      rowUpdates.length >= PROGRESS_FLUSH_INTERVAL ||
      processedCount === totalToVerify;

    if (shouldFlush && rowUpdates.length > 0) {
      await flushRowUpdates(rowUpdates.splice(0)); // drain the accumulator
      await prisma.bulkJob.update({
        where: { id: jobId },
        data:  { processedCount, validCount, invalidCount, riskyCount, unknownCount, errorCount },
      });

      const pct = totalToVerify > 0 ? Math.round((processedCount / totalToVerify) * 100) : 100;
      await job.updateProgress(pct);
      log.info({ processedCount, total: totalToVerify, pct }, 'Progress');
    }
  }

  // Final flush for any stragglers
  if (rowUpdates.length > 0) {
    await flushRowUpdates(rowUpdates.splice(0));
  }

  // ── 7. Build and upload export CSV ────────────────────────────────────────
  // Fetched in pages so a 100k-row job doesn't hold every row object in memory
  // at once — only the compact CSV string accumulates.
  const EXPORT_PAGE = 2_000;
  const exportPath  = `exports/${apiKeyId}/${jobId}/results.csv`;
  let exportUploaded = false;

  try {
    const csvParts: string[] = [EXPORT_CSV_HEADER];
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await prisma.bulkJobEmail.findMany({
        where:   { bulkJobId: jobId },
        orderBy: { rowIndex: 'asc' },
        skip:    offset,
        take:    EXPORT_PAGE,
        select: {
          email:         true,
          isDuplicate:   true,
          status:        true,
          subStatus:     true,
          score:         true,
          domain:        true,
          syntaxValid:   true,
          isDisposable:  true,
          isRoleAccount: true,
          mxFound:       true,
          smtpChecked:   true,
          smtpReachable: true,
          isCatchAll:    true,
          greylisted:    true,
          spfValid:      true,
          dkimFound:     true,
          dmarcValid:    true,
          blacklisted:   true,
          durationMs:    true,
          errorMessage:  true,
          processedAt:   true,
        },
      });
      if (page.length === 0) break;
      csvParts.push(buildExportCsvRows(page));
      if (page.length < EXPORT_PAGE) break;
    }

    await uploadToStorage(
      config.STORAGE_BUCKET_EXPORTS,
      exportPath,
      Buffer.from(csvParts.join(''), 'utf-8'),
      'text/csv',
    );
    exportUploaded = true;
  } catch (err) {
    log.error({ err }, 'Export CSV build/upload failed — job still marked completed');
    // Not fatal — results are still in bulk_job_emails; the export is a convenience
  }

  // ── 8. Mark completed ─────────────────────────────────────────────────────
  await prisma.bulkJob.update({
    where: { id: jobId },
    data: {
      status:         'completed',
      processedCount,
      validCount,
      invalidCount,
      riskyCount,
      unknownCount,
      errorCount,
      duplicateCount: dupeCount,
      // Only persist the path if the file actually exists in storage —
      // otherwise the results route would hand out signed URLs to nothing.
      exportPath:     exportUploaded ? exportPath : null,
      completedAt:    new Date(),
    },
  });

  // Bulk verifications count toward the key's monthly quota
  await incrementUsageBy(apiKeyId, processedCount);

  log.info({ processedCount, validCount, invalidCount, riskyCount, unknownCount, errorCount },
    'Bulk job completed');

  // ── 9. Dispatch webhooks ───────────────────────────────────────────────────
  await dispatchBulkCompleteWebhooks(jobId, apiKeyId, {
    fileName,
    totalEmails:   emailRows.length,
    validCount,
    invalidCount,
    riskyCount,
    unknownCount,
    duplicateCount: dupeCount,
    errorCount,
  });
}

// ─── Batch row update ─────────────────────────────────────────────────────────

async function flushRowUpdates(updates: Array<{
  id:             string;
  status:         string | null;
  subStatus:      string | null;
  score:          number | null;
  domain:         string | null;
  syntaxValid:    boolean | null;
  isDisposable:   boolean | null;
  isRoleAccount:  boolean | null;
  mxFound:        boolean | null;
  smtpChecked:    boolean | null;
  smtpReachable:  boolean | null;
  isCatchAll:     boolean | null;
  greylisted:     boolean;
  spfValid:       boolean | null;
  dkimFound:      boolean | null;
  dmarcValid:     boolean | null;
  blacklisted:    boolean | null;
  durationMs:     number | null;
  verificationId: string | null;
  errorMessage:   string | null;
  processedAt:    Date;
}>): Promise<void> {
  // Prisma doesn't support bulk UPDATE with different values per row without raw SQL.
  // We use a transaction with individual updates batched together.
  // For 25-row chunks this is fast enough; if needed, upgrade to raw SQL UNNEST.
  await prisma.$transaction(
    updates.map((u) =>
      prisma.bulkJobEmail.update({
        where: { id: u.id },
        data: {
          status:         u.status,
          subStatus:      u.subStatus,
          score:          u.score,
          domain:         u.domain,
          syntaxValid:    u.syntaxValid,
          isDisposable:   u.isDisposable,
          isRoleAccount:  u.isRoleAccount,
          mxFound:        u.mxFound,
          smtpChecked:    u.smtpChecked,
          smtpReachable:  u.smtpReachable,
          isCatchAll:     u.isCatchAll,
          greylisted:     u.greylisted,
          spfValid:       u.spfValid,
          dkimFound:      u.dkimFound,
          dmarcValid:     u.dmarcValid,
          blacklisted:    u.blacklisted,
          durationMs:     u.durationMs,
          verificationId: u.verificationId,
          errorMessage:   u.errorMessage,
          processedAt:    u.processedAt,
        },
      }),
    ),
  );
}

// ─── Export CSV builder ───────────────────────────────────────────────────────

type ExportRow = {
  email:         string;
  isDuplicate:   boolean;
  status:        string | null;
  subStatus:     string | null;
  score:         number | null;
  domain:        string | null;
  syntaxValid:   boolean | null;
  isDisposable:  boolean | null;
  isRoleAccount: boolean | null;
  mxFound:       boolean | null;
  smtpChecked:   boolean | null;
  smtpReachable: boolean | null;
  isCatchAll:    boolean | null;
  greylisted:    boolean;
  spfValid:      boolean | null;
  dkimFound:     boolean | null;
  dmarcValid:    boolean | null;
  blacklisted:   boolean | null;
  durationMs:    number | null;
  errorMessage:  string | null;
  processedAt:   Date | null;
};

// Full signal set (all 12 checks) plus a plain-English "reason" so a customer
// can see WHY each address got its verdict without decoding sub-status codes.
const EXPORT_CSV_HEADER =
  'email,isDuplicate,status,reason,subStatus,score,domain,' +
  'syntaxValid,mxFound,smtpChecked,smtpReachable,isCatchAll,greylisted,' +
  'isDisposable,isRoleAccount,spfValid,dkimFound,dmarcValid,blacklisted,' +
  'durationMs,errorMessage,processedAt\n';

/** Human-readable explanation of the verdict, built from the signals. */
function explainReason(r: ExportRow): string {
  if (r.errorMessage) return 'Verification error — not checked';
  if (r.isDuplicate)  return 'Duplicate of an earlier row';

  switch (r.status) {
    case 'valid':
      return 'Deliverable — mailbox accepted verification';
    case 'invalid':
      if (r.syntaxValid === false)  return 'Invalid — malformed email address';
      if (r.mxFound === false)      return 'Invalid — domain has no mail server (no MX)';
      if (r.smtpReachable === false) return 'Invalid — mail server rejected the mailbox';
      return 'Invalid — undeliverable';
    case 'risky':
      if (r.isCatchAll)     return 'Risky — catch-all domain, mailbox can’t be individually confirmed';
      if (r.isRoleAccount)  return 'Risky — role account (e.g. info@, support@)';
      if (r.isDisposable)   return 'Risky — disposable / temporary email domain';
      if (r.blacklisted)    return 'Risky — sending domain is on a blacklist';
      return 'Risky — deliverable but with quality flags';
    case 'unknown':
      if (r.greylisted)          return 'Unknown — mail server greylisted the probe, retry later';
      if (r.smtpChecked === false) return 'Unknown — mailbox check unavailable for this domain';
      return 'Unknown — could not determine deliverability';
    default:
      return '';
  }
}

function buildExportCsvRows(rows: ExportRow[]): string {
  const b = (v: boolean | null): string => (v !== null ? String(v) : '');
  const body = rows.map((r) => {
    const cols = [
      r.email,
      String(r.isDuplicate),
      r.status        ?? '',
      explainReason(r),
      r.subStatus     ?? '',
      r.score !== null ? String(r.score) : '',
      r.domain        ?? '',
      b(r.syntaxValid),
      b(r.mxFound),
      b(r.smtpChecked),
      b(r.smtpReachable),
      b(r.isCatchAll),
      String(r.greylisted),
      b(r.isDisposable),
      b(r.isRoleAccount),
      b(r.spfValid),
      b(r.dkimFound),
      b(r.dmarcValid),
      b(r.blacklisted),
      r.durationMs !== null ? String(r.durationMs) : '',
      r.errorMessage ? `"${r.errorMessage.replace(/"/g, '""')}"` : '',
      r.processedAt ? r.processedAt.toISOString() : '',
    ];
    return cols.map((c) =>
      c.includes(',') && !c.startsWith('"') ? `"${c}"` : c,
    ).join(',');
  }).join('\n');

  return body + '\n';
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

interface BulkCompleteSummary {
  fileName:      string;
  totalEmails:   number;
  validCount:    number;
  invalidCount:  number;
  riskyCount:    number;
  unknownCount:  number;
  duplicateCount: number;
  errorCount:    number;
}

async function dispatchBulkCompleteWebhooks(
  jobId:    string,
  apiKeyId: string,
  summary:  BulkCompleteSummary,
): Promise<void> {
  await dispatchWebhook({
    apiKeyId,
    event:   'bulk_job.completed',
    eventId: buildEventId('bulk_job.completed', jobId),
    payload: {
      event:         'bulk_job.completed',
      jobId,
      fileName:      summary.fileName,
      totalEmails:   summary.totalEmails,
      validCount:    summary.validCount,
      invalidCount:  summary.invalidCount,
      riskyCount:    summary.riskyCount,
      unknownCount:  summary.unknownCount,
      duplicateCount: summary.duplicateCount ?? 0,
      errorCount:    summary.errorCount ?? 0,
      completedAt:   new Date().toISOString(),
      apiVersion:    '2',
    },
  });

  await prisma.bulkJob.update({
    where: { id: jobId },
    data:  { webhookSent: true },
  });
}

// ─── Failure helper ───────────────────────────────────────────────────────────

async function failJob(jobId: string, errorMessage: string): Promise<void> {
  await prisma.bulkJob.update({
    where: { id: jobId },
    data: {
      status:       'failed',
      errorMessage: errorMessage.slice(0, 1000),
      completedAt:  new Date(),
    },
  });
  logger.warn({ jobId, errorMessage }, 'Bulk job failed');
}

// ─── Stall recovery ───────────────────────────────────────────────────────────

/**
 * On worker startup, find any jobs left in 'processing' state from a previous
 * crash and re-enqueue them. BullMQ's own stall detection handles queue-level
 * requeuing, but we also reset the DB status to 'pending' so the UI is consistent.
 */
async function recoverStalledJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60_000); // 30 minutes ago

  const stalled = await prisma.bulkJob.findMany({
    where: {
      status:   'processing',
      startedAt: { lt: cutoff },
    },
    select: { id: true, fileName: true, apiKeyId: true, storagePath: true },
  });

  if (stalled.length === 0) return;

  logger.warn({ count: stalled.length }, 'Found stalled bulk jobs — re-enqueuing');

  for (const job of stalled) {
    // Do NOT reset the counts — the worker resumes from already-processed rows,
    // so keeping the partial progress means a reclaimed job continues instead
    // of re-verifying (and re-charging) everything from zero.
    await prisma.bulkJob.update({
      where: { id: job.id },
      data:  { status: 'pending', startedAt: null },
    });

    // Re-create the BullMQ job (will no-op if it already exists due to jobId dedup)
    const queue = new Queue<BulkJobPayload>(QUEUE_BULK, { connection: redisConnection });
    await queue.add(
      'process-bulk',
      { jobId: job.id, apiKeyId: job.apiKeyId, storagePath: job.storagePath, fileName: job.fileName },
      { jobId: `bulk-${job.id}` },
    );
    await queue.close();

    logger.info({ jobId: job.id }, 'Stalled job re-enqueued');
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function startBulkWorker(): void {
  loadDisposableList();

  void recoverStalledJobs();

  const worker = new Worker<BulkJobPayload>(QUEUE_BULK, processBulkJob, {
    connection:      redisConnection,
    concurrency:     3,
    stalledInterval: 1_800_000,  // 30-min heartbeat for large jobs
    // Tolerate a few stalls (Redis blips over a multi-hour job) before giving
    // up. Safe now that the worker RESUMES from already-processed rows, so a
    // reclaim continues rather than restarting/re-charging.
    maxStalledCount: 3,
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.data.jobId, bullJobId: job.id }, 'BullMQ job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.data.jobId, bullJobId: job?.id, err }, 'BullMQ job failed');
    if (job?.data.jobId) void failJob(job.data.jobId, err.message);
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Bulk worker error');
  });

  logger.info({ concurrency: 3 }, 'Bulk worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Bulk worker shutting down');
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

// Do not auto-start in test environment
export { startBulkWorker };
if (process.env['NODE_ENV'] !== 'test') {
  startBulkWorker();
}

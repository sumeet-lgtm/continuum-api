import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { uploadToStorage, createSignedUrl } from '../../lib/supabase.js';
import { bulkQueue } from '../../lib/queue.js';
import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import type {
  BulkJobResponse,
  BulkJobResultsResponse,
  BulkJobEmailRow,
  ParsedEmail,
} from '../../types/job.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ROWS          = 100_000;
const EXPORT_URL_TTL_S  = 3_600;   // signed URL valid for 1 hour

// ─── Query schema for results pagination/filtering ────────────────────────────

const resultsQuerySchema = z.object({
  page:        z.coerce.number().int().min(1).default(1),
  limit:       z.coerce.number().int().min(1).max(1_000).default(100),
  status:      z.enum(['valid', 'invalid', 'risky', 'unknown']).optional(),
  isDuplicate: z
    .string()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined))
    .optional(),
});

interface BulkJobParams { id: string }

// ─── Route handler ────────────────────────────────────────────────────────────

export async function bulkJobRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /v1/bulk-jobs ──────────────────────────────────────────────────────
  fastify.post(
    '/bulk-jobs',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await request.file();

      if (!data) {
        throw Errors.validationFailed({
          file: 'No file uploaded. Send multipart/form-data with a "file" field.',
        });
      }

      const originalName = (data.filename ?? 'upload.csv').trim() || 'upload.csv';
      const mimetype     = data.mimetype ?? '';

      if (!isCSVMimeType(mimetype, originalName)) {
        throw Errors.validationFailed({ file: 'Only CSV files are accepted.' });
      }

      // Buffer the entire upload — max size enforced by @fastify/multipart limits (50 MB)
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer);
      }
      const fileBuffer = Buffer.concat(chunks);

      if (fileBuffer.length === 0) {
        throw Errors.validationFailed({ file: 'Uploaded file is empty.' });
      }

      // Parse the CSV and extract the email rows
      const parsed = parseCsv(fileBuffer.toString('utf-8'));

      if (parsed.length === 0) {
        throw Errors.validationFailed({ file: 'No email rows found in file.' });
      }

      if (parsed.length > MAX_ROWS) {
        throw Errors.validationFailed({
          file: `File contains ${parsed.length} rows; maximum is ${MAX_ROWS}.`,
        });
      }

      const jobId      = randomUUID();
      const storagePath = `uploads/${request.apiKey.id}/${jobId}/${originalName}`;

      // Upload the raw file to Supabase Storage first
      try {
        await uploadToStorage(
          config.STORAGE_BUCKET_UPLOADS,
          storagePath,
          fileBuffer,
          'text/csv',
        );
      } catch (err) {
        logger.error({ err, jobId }, 'CSV upload to storage failed');
        throw Errors.serviceUnavailable('Storage');
      }

      const totalEmails     = parsed.length;
      const duplicateCount  = parsed.filter((r) => r.isDuplicate).length;

      // Create the BulkJob record and pre-create BulkJobEmail rows in one transaction
      const bulkJob = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const job = await tx.bulkJob.create({
          data: {
            id:             jobId,
            apiKeyId:       request.apiKey.id,
            fileName:       originalName,
            storagePath,
            totalEmails,
            duplicateCount,
            status:         'pending',
          },
          select: {
            id:            true,
            fileName:      true,
            totalEmails:   true,
            duplicateCount: true,
            status:        true,
            createdAt:     true,
          },
        });

        // Insert all email rows in batches of 500 to avoid hitting Postgres param limits
        const BATCH = 500;
        for (let i = 0; i < parsed.length; i += BATCH) {
          const slice = parsed.slice(i, i + BATCH);
          await tx.bulkJobEmail.createMany({
            data: slice.map((r) => ({
              id:          randomUUID(),
              bulkJobId:   jobId,
              email:       r.email,
              rowIndex:    r.rowIndex,
              isDuplicate: r.isDuplicate,
            })),
          });
        }

        return job;
      });

      // Enqueue the background job
      await bulkQueue.add(
        'process-bulk',
        { jobId, apiKeyId: request.apiKey.id, storagePath, fileName: originalName },
        { jobId: `bulk:${jobId}` },
      );

      logger.info(
        { jobId, totalEmails, duplicateCount, apiKeyId: request.apiKey.id },
        'Bulk job created',
      );

      return reply.status(202).send({
        id:            bulkJob.id,
        fileName:      bulkJob.fileName,
        status:        bulkJob.status,
        totalEmails:   bulkJob.totalEmails,
        duplicateCount: bulkJob.duplicateCount,
        createdAt:     bulkJob.createdAt.toISOString(),
        statusUrl:     `/v1/bulk-jobs/${bulkJob.id}`,
        resultsUrl:    `/v1/bulk-jobs/${bulkJob.id}/results`,
      });
    },
  );

  // ── GET /v1/bulk-jobs/:id ───────────────────────────────────────────────────
  fastify.get<{ Params: BulkJobParams }>(
    '/bulk-jobs/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BulkJobParams }>, reply: FastifyReply) => {
      const job = await prisma.bulkJob.findUnique({
        where: { id: request.params.id },
        select: {
          id:             true,
          apiKeyId:       true,
          fileName:       true,
          totalEmails:    true,
          processedCount: true,
          validCount:     true,
          invalidCount:   true,
          riskyCount:     true,
          unknownCount:   true,
          duplicateCount: true,
          errorCount:     true,
          status:         true,
          errorMessage:   true,
          exportPath:     true,
          createdAt:      true,
          startedAt:      true,
          completedAt:    true,
          cancelledAt:    true,
        },
      });

      if (!job || job.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Bulk job');
      }

      const processed = job.processedCount;
      const total     = job.totalEmails;
      const pct       = total > 0 ? Math.round((processed / total) * 100) : 0;

      const response: BulkJobResponse = {
        id:       job.id,
        fileName: job.fileName,
        status:   job.status as BulkJobResponse['status'],
        progress: {
          total,
          processed,
          duplicates:      job.duplicateCount,
          errors:          job.errorCount,
          percentComplete: pct,
        },
        results: {
          valid:   job.validCount,
          invalid: job.invalidCount,
          risky:   job.riskyCount,
          unknown: job.unknownCount,
        },
        errorMessage: job.errorMessage,
        exportReady:  job.status === 'completed' && job.exportPath !== null,
        createdAt:    job.createdAt.toISOString(),
        startedAt:    job.startedAt?.toISOString()  ?? null,
        completedAt:  job.completedAt?.toISOString() ?? null,
        cancelledAt:  job.cancelledAt?.toISOString() ?? null,
      };

      return reply.status(200).send(response);
    },
  );

  // ── GET /v1/bulk-jobs/:id/results ───────────────────────────────────────────
  // Returns paginated per-email results stored in bulk_job_emails.
  // Does NOT require the export file — results are queryable from DB immediately.
  fastify.get<{ Params: BulkJobParams }>(
    '/bulk-jobs/:id/results',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BulkJobParams }>, reply: FastifyReply) => {
      // ── Validate query params ──────────────────────────────────────────────
      const queryResult = resultsQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw Errors.validationFailed(
          queryResult.error.issues.map((i) => ({
            field:   i.path.join('.'),
            message: i.message,
          })),
        );
      }
      const { page, limit, status, isDuplicate } = queryResult.data;

      // ── Verify job ownership ───────────────────────────────────────────────
      const job = await prisma.bulkJob.findUnique({
        where: { id: request.params.id },
        select: {
          id:           true,
          apiKeyId:     true,
          fileName:     true,
          status:       true,
          totalEmails:  true,
          exportPath:   true,
        },
      });

      if (!job || job.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Bulk job');
      }

      // ── Build Prisma where clause ──────────────────────────────────────────
      type WhereClause = {
        bulkJobId:   string;
        status?:     string;
        isDuplicate?: boolean;
      };

      const where: WhereClause = { bulkJobId: job.id };
      if (status    !== undefined) where.status     = status;
      if (isDuplicate !== undefined) where.isDuplicate = isDuplicate;

      const skip = (page - 1) * limit;

      const [rows, total] = await Promise.all([
        prisma.bulkJobEmail.findMany({
          where,
          orderBy: { rowIndex: 'asc' },
          skip,
          take: limit,
          select: {
            email:          true,
            rowIndex:       true,
            isDuplicate:    true,
            status:         true,
            subStatus:      true,
            score:          true,
            domain:         true,
            isDisposable:   true,
            isRoleAccount:  true,
            mxFound:        true,
            smtpChecked:    true,
            smtpReachable:  true,
            isCatchAll:     true,
            greylisted:     true,
            durationMs:     true,
            verificationId: true,
            errorMessage:   true,
            processedAt:    true,
          },
        }),
        prisma.bulkJobEmail.count({ where }),
      ]);

      // ── Build download URL if export is ready ──────────────────────────────
      let exportUrl: string | null = null;
      if (job.status === 'completed' && job.exportPath) {
        try {
          exportUrl = await createSignedUrl(
            config.STORAGE_BUCKET_EXPORTS,
            job.exportPath,
            EXPORT_URL_TTL_S,
          );
        } catch {
          // Non-fatal — results are still available inline
          logger.warn({ jobId: job.id }, 'Could not generate export signed URL');
        }
      }

      const data: BulkJobEmailRow[] = rows.map((r: typeof rows[number]) => ({
        email:          r.email,
        rowIndex:       r.rowIndex,
        isDuplicate:    r.isDuplicate,
        status:         r.status,
        subStatus:      r.subStatus,
        score:          r.score,
        domain:         r.domain,
        isDisposable:   r.isDisposable,
        isRoleAccount:  r.isRoleAccount,
        mxFound:        r.mxFound,
        smtpChecked:    r.smtpChecked,
        smtpReachable:  r.smtpReachable,
        isCatchAll:     r.isCatchAll,
        greylisted:     r.greylisted,
        durationMs:     r.durationMs,
        verificationId: r.verificationId,
        errorMessage:   r.errorMessage,
        processedAt:    r.processedAt?.toISOString() ?? null,
      }));

      const response: BulkJobResultsResponse & { exportUrl: string | null } = {
        jobId:     job.id,
        fileName:  job.fileName,
        status:    job.status as BulkJobResultsResponse['status'],
        totalEmails: job.totalEmails,
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: {
          status:      status ?? null,
          isDuplicate: isDuplicate ?? null,
        },
        exportUrl,
      };

      return reply.status(200).send(response);
    },
  );
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a CSV buffer into a list of ParsedEmail rows.
 *
 * Rules:
 *   - First row skipped if it looks like a header (contains "email"/"address" or has no "@")
 *   - Only the first column of each row is used
 *   - Surrounding quotes, whitespace stripped
 *   - All emails lowercased
 *   - Duplicates are flagged but preserved in the row list (so rowIndex is stable)
 *   - Rows that produce an empty string after cleaning are dropped silently
 */
export function parseCsv(text: string): ParsedEmail[] {
  const lines = text.split('\n');
  const results: ParsedEmail[] = [];
  const seen   = new Set<string>();
  let rowIndex  = 0;
  let headerSkipped = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Skip header row
    if (!headerSkipped) {
      headerSkipped = true;
      const lower = line.toLowerCase();
      if (
        lower.startsWith('email') ||
        lower.startsWith('address') ||
        lower.startsWith('"email') ||
        !line.includes('@')
      ) {
        continue;
      }
    }

    const email = extractFirstColumn(line);
    if (!email) continue;

    const isDuplicate = seen.has(email);
    if (!isDuplicate) seen.add(email);

    results.push({ email, rowIndex: rowIndex++, isDuplicate });
  }

  return results;
}

function extractFirstColumn(line: string): string {
  // Handle quoted fields: "value","other"
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end !== -1) {
      return line.slice(1, end).trim().toLowerCase();
    }
  }

  const first = (line.split(',')[0] ?? line).trim();
  return first.replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
}

function isCSVMimeType(mimetype: string, filename: string): boolean {
  return (
    mimetype === 'text/csv'        ||
    mimetype === 'application/csv' ||
    mimetype === 'text/plain'      ||
    mimetype === 'application/octet-stream' ||
    filename.toLowerCase().endsWith('.csv')
  );
}

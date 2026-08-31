-- Phase 3: bulk verification enhancements

-- Add metadata columns to bulk_jobs
ALTER TABLE "bulk_jobs"
  ADD COLUMN IF NOT EXISTS "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "errorCount"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cancelledAt"    TIMESTAMP(3);

-- New table: one row per email in a bulk job, holds the outcome inline.
-- Enables GET /v1/bulk-jobs/:id/results to page through results
-- without Supabase Storage access.
CREATE TABLE IF NOT EXISTS "bulk_job_emails" (
  "id"             TEXT          NOT NULL,
  "bulkJobId"      TEXT          NOT NULL,
  "email"          TEXT          NOT NULL,
  "rowIndex"       INTEGER       NOT NULL,
  "isDuplicate"    BOOLEAN       NOT NULL DEFAULT false,
  "status"         TEXT,
  "subStatus"      TEXT,
  "score"          INTEGER,
  "domain"         TEXT,
  "isDisposable"   BOOLEAN,
  "isRoleAccount"  BOOLEAN,
  "mxFound"        BOOLEAN,
  "smtpChecked"    BOOLEAN,
  "smtpReachable"  BOOLEAN,
  "isCatchAll"     BOOLEAN,
  "greylisted"     BOOLEAN       NOT NULL DEFAULT false,
  "durationMs"     INTEGER,
  "verificationId" TEXT,
  "errorMessage"   TEXT,
  "processedAt"    TIMESTAMP(3),

  CONSTRAINT "bulk_job_emails_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bulk_job_emails_bulkJobId_idx"
  ON "bulk_job_emails"("bulkJobId");
CREATE INDEX IF NOT EXISTS "bulk_job_emails_status_idx"
  ON "bulk_job_emails"("bulkJobId", "status");
CREATE INDEX IF NOT EXISTS "bulk_job_emails_rowIndex_idx"
  ON "bulk_job_emails"("bulkJobId", "rowIndex");

ALTER TABLE "bulk_job_emails"
  ADD CONSTRAINT "bulk_job_emails_bulkJobId_fkey"
  FOREIGN KEY ("bulkJobId") REFERENCES "bulk_jobs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

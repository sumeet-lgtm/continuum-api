-- ================================================================
-- CONTINUUM: Complete database setup
-- Paste this entire file into:
-- Supabase Dashboard → SQL Editor → paste → click Run
-- ================================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE "VerificationStatus" AS ENUM ('valid','invalid','risky','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BulkJobStatus" AS ENUM ('pending','processing','completed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WebhookEvent" AS ENUM ('verification_complete','bulk_job_complete','monitor_status_change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- api_keys
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "keyHash"     TEXT        NOT NULL,
  "keyPrefix"   TEXT        NOT NULL,
  "label"       TEXT,
  "ownerId"     TEXT,
  "rateLimit"   INTEGER     NOT NULL DEFAULT 1000,
  "isActive"    BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now(),
  "revokedAt"   TIMESTAMP(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- verifications
CREATE TABLE IF NOT EXISTS "verifications" (
  "id"              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "email"           TEXT        NOT NULL,
  "domain"          TEXT        NOT NULL,
  "status"          "VerificationStatus" NOT NULL,
  "subStatus"       TEXT,
  "syntaxValid"     BOOLEAN     NOT NULL,
  "mxFound"         BOOLEAN     NOT NULL,
  "mxRecords"       TEXT[]      NOT NULL DEFAULT '{}',
  "isDisposable"    BOOLEAN     NOT NULL,
  "isRoleAccount"   BOOLEAN     NOT NULL,
  "smtpChecked"     BOOLEAN     NOT NULL,
  "smtpReachable"   BOOLEAN,
  "smtpRawResponse" TEXT,
  "isCatchAll"      BOOLEAN,
  "greylisted"      BOOLEAN     NOT NULL DEFAULT false,
  "score"           INTEGER     NOT NULL,
  "durationMs"      INTEGER     NOT NULL,
  "checkedAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "apiKeyId"        TEXT        NOT NULL,
  "bulkJobId"       TEXT,
  "sourceIp"        TEXT,
  CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "verifications_email_idx"     ON "verifications"("email");
CREATE INDEX IF NOT EXISTS "verifications_apiKeyId_idx"  ON "verifications"("apiKeyId");
CREATE INDEX IF NOT EXISTS "verifications_checkedAt_idx" ON "verifications"("checkedAt");
CREATE INDEX IF NOT EXISTS "verifications_bulkJobId_idx" ON "verifications"("bulkJobId");

-- bulk_jobs
CREATE TABLE IF NOT EXISTS "bulk_jobs" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "apiKeyId"       TEXT        NOT NULL,
  "fileName"       TEXT        NOT NULL,
  "storagePath"    TEXT        NOT NULL,
  "totalEmails"    INTEGER     NOT NULL,
  "processedCount" INTEGER     NOT NULL DEFAULT 0,
  "validCount"     INTEGER     NOT NULL DEFAULT 0,
  "invalidCount"   INTEGER     NOT NULL DEFAULT 0,
  "riskyCount"     INTEGER     NOT NULL DEFAULT 0,
  "unknownCount"   INTEGER     NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER     NOT NULL DEFAULT 0,
  "errorCount"     INTEGER     NOT NULL DEFAULT 0,
  "status"         "BulkJobStatus" NOT NULL DEFAULT 'pending',
  "errorMessage"   TEXT,
  "exportPath"     TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "startedAt"      TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "cancelledAt"    TIMESTAMP(3),
  "webhookSent"    BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT "bulk_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bulk_jobs_apiKeyId_idx" ON "bulk_jobs"("apiKeyId");
CREATE INDEX IF NOT EXISTS "bulk_jobs_status_idx"   ON "bulk_jobs"("status");
CREATE INDEX IF NOT EXISTS "bulk_jobs_createdAt_idx" ON "bulk_jobs"("createdAt");

-- bulk_job_emails
CREATE TABLE IF NOT EXISTS "bulk_job_emails" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "bulkJobId"      TEXT        NOT NULL,
  "email"          TEXT        NOT NULL,
  "rowIndex"       INTEGER     NOT NULL,
  "isDuplicate"    BOOLEAN     NOT NULL DEFAULT false,
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
  "greylisted"     BOOLEAN     NOT NULL DEFAULT false,
  "durationMs"     INTEGER,
  "verificationId" TEXT,
  "errorMessage"   TEXT,
  "processedAt"    TIMESTAMP(3),
  CONSTRAINT "bulk_job_emails_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bulk_job_emails_bulkJobId_idx"   ON "bulk_job_emails"("bulkJobId");
CREATE INDEX IF NOT EXISTS "bulk_job_emails_status_idx"      ON "bulk_job_emails"("bulkJobId","status");
CREATE INDEX IF NOT EXISTS "bulk_job_emails_rowIndex_idx"    ON "bulk_job_emails"("bulkJobId","rowIndex");

-- monitors
CREATE TABLE IF NOT EXISTS "monitors" (
  "id"                   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "apiKeyId"             TEXT        NOT NULL,
  "email"                TEXT        NOT NULL,
  "intervalHours"        INTEGER     NOT NULL DEFAULT 24,
  "isActive"             BOOLEAN     NOT NULL DEFAULT true,
  "lastCheckedAt"        TIMESTAMP(3),
  "nextCheckAt"          TIMESTAMP(3) NOT NULL,
  "lastStatus"           "VerificationStatus",
  "consecutiveFailures"  INTEGER     NOT NULL DEFAULT 0,
  "pausedAt"             TIMESTAMP(3),
  "failureReason"        TEXT,
  "tags"                 TEXT[]      NOT NULL DEFAULT '{}',
  "notifyOnAnyChange"    BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "monitors_apiKeyId_email_key" ON "monitors"("apiKeyId","email");
CREATE INDEX IF NOT EXISTS "monitors_nextCheckAt_idx"           ON "monitors"("nextCheckAt");
CREATE INDEX IF NOT EXISTS "monitors_isActive_nextCheckAt_idx"  ON "monitors"("isActive","nextCheckAt");

-- monitor_checks
CREATE TABLE IF NOT EXISTS "monitor_checks" (
  "id"             TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "monitorId"      TEXT        NOT NULL,
  "verificationId" TEXT        NOT NULL,
  "statusChanged"  BOOLEAN     NOT NULL,
  "previousStatus" "VerificationStatus",
  "newStatus"      "VerificationStatus" NOT NULL,
  "source"         TEXT        NOT NULL DEFAULT 'scheduled',
  "checkedAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "durationMs"     INTEGER,
  "webhookSent"    BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT "monitor_checks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "monitor_checks_monitorId_idx"           ON "monitor_checks"("monitorId");
CREATE INDEX IF NOT EXISTS "monitor_checks_monitorId_checkedAt_idx" ON "monitor_checks"("monitorId","checkedAt");
CREATE INDEX IF NOT EXISTS "monitor_checks_checkedAt_idx"           ON "monitor_checks"("checkedAt");

-- webhooks
CREATE TABLE IF NOT EXISTS "webhooks" (
  "id"              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "apiKeyId"        TEXT        NOT NULL,
  "url"             TEXT        NOT NULL,
  "secret"          TEXT        NOT NULL,
  "events"          "WebhookEvent"[] NOT NULL DEFAULT '{}',
  "label"           TEXT,
  "description"     TEXT,
  "isActive"        BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lastPingAt"      TIMESTAMP(3),
  "lastPingOk"      BOOLEAN,
  "totalDeliveries" INTEGER     NOT NULL DEFAULT 0,
  "successCount"    INTEGER     NOT NULL DEFAULT 0,
  "failureCount"    INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "webhooks_apiKeyId_idx" ON "webhooks"("apiKeyId");

-- webhook_deliveries
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"                TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "webhookId"         TEXT        NOT NULL,
  "event"             "WebhookEvent" NOT NULL,
  "eventId"           TEXT,
  "payload"           JSONB       NOT NULL DEFAULT '{}',
  "attempts"          INTEGER     NOT NULL DEFAULT 0,
  "maxAttempts"       INTEGER     NOT NULL DEFAULT 5,
  "nextRetryAt"       TIMESTAMP(3),
  "lastAttemptAt"     TIMESTAMP(3),
  "statusCode"        INTEGER,
  "responseBody"      TEXT,
  "errorMessage"      TEXT,
  "delivered"         BOOLEAN     NOT NULL DEFAULT false,
  "failedPermanently" BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "webhook_deliveries_delivered_nextRetryAt_idx" ON "webhook_deliveries"("delivered","nextRetryAt");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhookId_idx"             ON "webhook_deliveries"("webhookId");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_eventId_idx"               ON "webhook_deliveries"("eventId") WHERE "eventId" IS NOT NULL;

-- webhook_attempts
CREATE TABLE IF NOT EXISTS "webhook_attempts" (
  "id"            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "deliveryId"    TEXT        NOT NULL,
  "attemptNumber" INTEGER     NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL,
  "respondedAt"   TIMESTAMP(3),
  "durationMs"    INTEGER,
  "statusCode"    INTEGER,
  "responseBody"  TEXT,
  "errorType"     TEXT,
  "errorMessage"  TEXT,
  "success"       BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "webhook_attempts_deliveryId_idx"     ON "webhook_attempts"("deliveryId");
CREATE INDEX IF NOT EXISTS "webhook_attempts_deliveryId_num_idx" ON "webhook_attempts"("deliveryId","attemptNumber");

-- Foreign key constraints (added last to avoid ordering issues)
DO $$ BEGIN
  ALTER TABLE "verifications"    ADD CONSTRAINT "verifications_apiKeyId_fkey"    FOREIGN KEY ("apiKeyId")   REFERENCES "api_keys"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "verifications"    ADD CONSTRAINT "verifications_bulkJobId_fkey"   FOREIGN KEY ("bulkJobId")  REFERENCES "bulk_jobs"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "bulk_jobs"        ADD CONSTRAINT "bulk_jobs_apiKeyId_fkey"        FOREIGN KEY ("apiKeyId")   REFERENCES "api_keys"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "bulk_job_emails"  ADD CONSTRAINT "bulk_job_emails_bulkJobId_fkey" FOREIGN KEY ("bulkJobId")  REFERENCES "bulk_jobs"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "monitors"         ADD CONSTRAINT "monitors_apiKeyId_fkey"         FOREIGN KEY ("apiKeyId")   REFERENCES "api_keys"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "monitor_checks"   ADD CONSTRAINT "monitor_checks_monitorId_fkey"  FOREIGN KEY ("monitorId")  REFERENCES "monitors"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webhooks"         ADD CONSTRAINT "webhooks_apiKeyId_fkey"         FOREIGN KEY ("apiKeyId")   REFERENCES "api_keys"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

SELECT 'Database setup complete. Tables created: ' || count(*)::text || ' tables'
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('api_keys','verifications','bulk_jobs','bulk_job_emails','monitors','monitor_checks','webhooks','webhook_deliveries','webhook_attempts');

-- ================================================================
-- YOUR FIRST API KEY
-- The raw key below is printed once. Save it before running this.
-- ================================================================
INSERT INTO "api_keys" ("id","keyHash","keyPrefix","label","rateLimit","isActive","createdAt")
VALUES (
  'e99e3531feff3381',
  'f7ff2144da8cedd901f0d0defd934d46e181c240dc0e0ff342256c228f435aa1',
  'cnt_4b5a6518',
  'production',
  1000,
  true,
  now()
) ON CONFLICT DO NOTHING;

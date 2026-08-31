-- Phase 5: Webhook enhancements
-- Note: WebhookEvent enum values remain as underscores in PostgreSQL.
-- The dot-style names (verification.completed etc.) are API-response-level only.

-- Add label, description, and delivery stats to webhooks
ALTER TABLE "webhooks"
  ADD COLUMN IF NOT EXISTS "label"           TEXT,
  ADD COLUMN IF NOT EXISTS "description"     TEXT,
  ADD COLUMN IF NOT EXISTS "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "successCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failureCount"    INTEGER NOT NULL DEFAULT 0;

-- Add structured error tracking and permanent-failure flag to deliveries
ALTER TABLE "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "failedPermanently" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "errorMessage"      TEXT,
  ADD COLUMN IF NOT EXISTS "eventId"           TEXT;

CREATE INDEX IF NOT EXISTS "webhook_deliveries_eventId_idx"
  ON "webhook_deliveries"("eventId")
  WHERE "eventId" IS NOT NULL;

-- Per-attempt log: one row per HTTP round-trip
CREATE TABLE IF NOT EXISTS "webhook_attempts" (
  "id"            TEXT         NOT NULL,
  "deliveryId"    TEXT         NOT NULL,
  "attemptNumber" INTEGER      NOT NULL,
  "requestedAt"   TIMESTAMP(3) NOT NULL,
  "respondedAt"   TIMESTAMP(3),
  "durationMs"    INTEGER,
  "statusCode"    INTEGER,
  "responseBody"  TEXT,
  "errorType"     TEXT,
  "errorMessage"  TEXT,
  "success"       BOOLEAN      NOT NULL DEFAULT false,

  CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_attempts_deliveryId_idx"
  ON "webhook_attempts"("deliveryId");
CREATE INDEX IF NOT EXISTS "webhook_attempts_deliveryId_num_idx"
  ON "webhook_attempts"("deliveryId", "attemptNumber");

ALTER TABLE "webhook_attempts"
  ADD CONSTRAINT "webhook_attempts_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "webhook_deliveries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 6: Send
-- Adds transactional sending on top of verification, plus a global
-- suppression list. SendMessage/SendEvent mirror the Verification/BulkJob
-- shape already used elsewhere; WebhookEvent gains 5 new underscore-form
-- values (dot-style names are API-response-level only, same convention as
-- Phase 5).

-- Send-specific quota fields on api_keys — separate counter from
-- currentMonthUsage (verifications and sends have different unit economics).
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "monthlySendLimit"      INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS "currentMonthSendUsage"  INTEGER NOT NULL DEFAULT 0;

-- New WebhookEvent enum values
ALTER TYPE "WebhookEvent" ADD VALUE IF NOT EXISTS 'email_sent';
ALTER TYPE "WebhookEvent" ADD VALUE IF NOT EXISTS 'email_delivered';
ALTER TYPE "WebhookEvent" ADD VALUE IF NOT EXISTS 'email_bounced';
ALTER TYPE "WebhookEvent" ADD VALUE IF NOT EXISTS 'email_complained';
ALTER TYPE "WebhookEvent" ADD VALUE IF NOT EXISTS 'email_send_failed';

-- New enums for Send
CREATE TYPE "SendStatus" AS ENUM ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed');
CREATE TYPE "SendEventType" AS ENUM ('sent', 'delivered', 'bounced', 'complained', 'failed');
CREATE TYPE "SuppressionReason" AS ENUM ('hard_bounce', 'complaint', 'manual');

-- ─── send_messages ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "send_messages" (
  "id"             TEXT         NOT NULL,
  "apiKeyId"       TEXT         NOT NULL,
  "to"             TEXT         NOT NULL,
  "from"           TEXT         NOT NULL,
  "replyTo"        TEXT,
  "subject"        TEXT         NOT NULL,
  "sesMessageId"   TEXT,
  "status"         "SendStatus" NOT NULL DEFAULT 'queued',
  "errorMessage"   TEXT,
  "verificationId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"         TIMESTAMP(3),

  CONSTRAINT "send_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "send_messages_sesMessageId_key" ON "send_messages"("sesMessageId");
CREATE INDEX IF NOT EXISTS "send_messages_apiKeyId_idx" ON "send_messages"("apiKeyId");
CREATE INDEX IF NOT EXISTS "send_messages_apiKeyId_createdAt_idx" ON "send_messages"("apiKeyId", "createdAt");
CREATE INDEX IF NOT EXISTS "send_messages_sesMessageId_idx" ON "send_messages"("sesMessageId");

ALTER TABLE "send_messages"
  ADD CONSTRAINT "send_messages_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "send_messages"
  ADD CONSTRAINT "send_messages_verificationId_fkey"
  FOREIGN KEY ("verificationId") REFERENCES "verifications"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── send_events ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "send_events" (
  "id"            TEXT            NOT NULL,
  "sendMessageId" TEXT            NOT NULL,
  "type"          "SendEventType" NOT NULL,
  "rawPayload"    JSONB           NOT NULL,
  "occurredAt"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "send_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "send_events_sendMessageId_idx" ON "send_events"("sendMessageId");

ALTER TABLE "send_events"
  ADD CONSTRAINT "send_events_sendMessageId_fkey"
  FOREIGN KEY ("sendMessageId") REFERENCES "send_messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── suppressions (global — not scoped by apiKeyId) ──────────────────────────

CREATE TABLE IF NOT EXISTS "suppressions" (
  "id"        TEXT                 NOT NULL,
  "email"     TEXT                 NOT NULL,
  "reason"    "SuppressionReason"  NOT NULL,
  "apiKeyId"  TEXT,
  "createdAt" TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "suppressions_email_key" ON "suppressions"("email");
CREATE INDEX IF NOT EXISTS "suppressions_email_idx" ON "suppressions"("email");

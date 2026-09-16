-- Idempotency/claim tables referenced by workers/emailSweep.ts and
-- routes/billing/index.ts but never created — both raw-SQL claims
-- (`insert ... on conflict (id) do nothing`) have been hitting
-- "relation does not exist" since the code was written. New tables only,
-- safe to run against a live database with no downtime.

CREATE TABLE IF NOT EXISTS "sent_emails" (
  "id"         TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sent_emails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "processed_webhooks" (
  "id"         TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id")
);

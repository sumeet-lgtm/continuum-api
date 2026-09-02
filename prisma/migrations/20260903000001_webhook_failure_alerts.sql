-- Webhook failure alerting: track consecutive permanent failures + debounce timestamp
ALTER TABLE "webhooks"
  ADD COLUMN IF NOT EXISTS "consecutive_failures"   INTEGER                  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failure_alert_sent_at"  TIMESTAMP WITH TIME ZONE;

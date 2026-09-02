-- IP allowlist per API key (empty = allow all)
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "allowed_ips"         TEXT[]    NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "usage_alert_enabled" BOOLEAN   NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "usage_alert_sent_at" TIMESTAMP WITH TIME ZONE;

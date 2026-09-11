-- Per-customer opt-out of the SES -> SMTP2GO send fallback (see
-- src/lib/sendTransport.ts). Defaults true — every existing key keeps the
-- current fallback behavior; a customer flips this off if they'd rather a
-- send fail outright than route through the backup provider.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "allow_send_fallback" BOOLEAN NOT NULL DEFAULT true;

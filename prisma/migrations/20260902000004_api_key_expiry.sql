-- API key expiry: auto-revoke keys at a specific UTC datetime
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP WITH TIME ZONE;

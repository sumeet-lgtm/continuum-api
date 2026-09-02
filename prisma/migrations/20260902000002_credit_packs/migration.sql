-- AddColumn: pay-per-use credit packs on ApiKey
-- Non-expiring top-up credits added on top of the monthly quota.
-- Consumed before the monthly quota is checked; never reset on monthly rollover.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "extra_verification_credits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "extra_send_credits"         INTEGER NOT NULL DEFAULT 0;

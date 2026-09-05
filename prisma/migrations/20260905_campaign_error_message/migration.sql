-- Campaign.errorMessage was already referenced in campaignWorker.ts (cast through
-- `as Record<string, unknown>` to dodge the type error) but the column never existed.
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

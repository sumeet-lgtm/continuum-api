-- AddColumn: send window fields for campaigns and sequences
-- Allows customers to restrict sends to specific days/hours in their timezone.

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "send_days"       TEXT[]  NOT NULL DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday'],
  ADD COLUMN IF NOT EXISTS "send_start_hour" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "send_end_hour"   INTEGER NOT NULL DEFAULT 17,
  ADD COLUMN IF NOT EXISTS "timezone"        TEXT    NOT NULL DEFAULT 'UTC';

ALTER TABLE "sequences"
  ADD COLUMN IF NOT EXISTS "send_days"       TEXT[]  NOT NULL DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday'],
  ADD COLUMN IF NOT EXISTS "send_start_hour" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "send_end_hour"   INTEGER NOT NULL DEFAULT 17,
  ADD COLUMN IF NOT EXISTS "timezone"        TEXT    NOT NULL DEFAULT 'UTC';

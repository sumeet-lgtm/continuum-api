-- A/B subject line testing for campaigns
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "subject_b"     TEXT,
  ADD COLUMN IF NOT EXISTS "open_count_b"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "click_count_b" INTEGER NOT NULL DEFAULT 0;

-- Track which A/B variant each recipient received
ALTER TABLE "campaign_recipients"
  ADD COLUMN IF NOT EXISTS "variant" TEXT NOT NULL DEFAULT 'a';

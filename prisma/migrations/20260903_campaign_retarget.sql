-- Campaign retargeting: store openers-to-skip + link back to source campaign
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "excluded_emails"  TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "retarget_of_id"   TEXT;

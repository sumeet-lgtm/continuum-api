ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "preheader" TEXT;

ALTER TABLE "email_templates"
  ADD COLUMN IF NOT EXISTS "preheader" TEXT;

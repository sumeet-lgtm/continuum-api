-- Adds the deliverability + syntax signals to bulk_job_emails so bulk exports
-- can show all 12 checks (previously bulk skipped SPF/DKIM/DMARC/blacklist and
-- the columns didn't exist). Applied to prod (ghdkanhhfhxfbskszuqk) 2026-07-07.
ALTER TABLE bulk_job_emails ADD COLUMN IF NOT EXISTS "syntaxValid" boolean;
ALTER TABLE bulk_job_emails ADD COLUMN IF NOT EXISTS "spfValid"    boolean;
ALTER TABLE bulk_job_emails ADD COLUMN IF NOT EXISTS "dkimFound"   boolean;
ALTER TABLE bulk_job_emails ADD COLUMN IF NOT EXISTS "dmarcValid"  boolean;
ALTER TABLE bulk_job_emails ADD COLUMN IF NOT EXISTS "blacklisted" boolean;

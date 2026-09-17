-- Enables RLS on sending_domains (holds dkimPrivateKeyEnc — an encrypted
-- DKIM private key per domain, per tenant). No-op today, same as the
-- other 2026-09-17 RLS migrations.
--
-- Application code updated in the same commit: src/routes/domains/index.ts,
-- src/lib/domainVerify.ts (withTenant — called from both the manual verify
-- route and the background worker, always with a known domain.apiKeyId),
-- src/workers/domainVerifyWorker.ts (withRlsBypass for the one legitimate
-- cross-tenant "every pending domain" scan), src/routes/send/index.ts,
-- src/routes/analytics/index.ts.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE sending_domains ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON sending_domains FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

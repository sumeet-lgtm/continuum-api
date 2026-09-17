-- Enables RLS on inbox_tests, brand_kits, and api_request_logs. Same
-- no-op-until-cutover situation as the other 2026-09-17 RLS migrations —
-- see 20260917_rls_connectors_salesforce for the full explanation.
--
-- Application code updated in the same commit:
--   src/routes/inbox-test/index.ts, src/routes/brand/index.ts,
--   src/routes/logs/index.ts, src/server.ts (onResponse request-log hook)
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE inbox_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_kits ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_request_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON inbox_tests FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON brand_kits FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON api_request_logs FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

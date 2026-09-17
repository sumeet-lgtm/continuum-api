-- Enables RLS on the 5 tables covering payment-connector rules/secrets/
-- event log and the Salesforce two-way sync connection + lead-sync state.
-- Same tenant_isolation pattern as every other table (see
-- 20260916_fix_rls_policy_gaps for the reference version of this policy).
--
-- This is currently a no-op in production: every service's DATABASE_URL
-- still connects as `postgres` (BYPASSRLS=true, see
-- 20260915_continuum_app_role's comment). It only starts being enforced
-- once DATABASE_URL is switched to the continuum_app role, which is a
-- separate, deliberately-staged change — not part of this migration.
--
-- Application code for these 5 tables (src/routes/connectors/payment.ts,
-- src/routes/connectors/salesforce.ts, src/workers/salesforceSyncWorker.ts)
-- was updated in the same commit to route every query through
-- withTenant()/withRlsBypass(), so enabling this now is safe whenever the
-- role cutover eventually happens — it isn't waiting on anything further
-- for these 5 tables specifically.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE connector_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE salesforce_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE salesforce_lead_syncs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON connector_secrets FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON connector_rules FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON connector_events FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON salesforce_connections FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON salesforce_lead_syncs FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Fixes two real gaps found auditing the RLS rollout for the pending
-- DATABASE_URL -> continuum_app cutover (see 20260915_continuum_app_role):
--
-- 1. api_keys, bulk_jobs, monitors, verifications, webhooks still carried
--    policies from the pre-WorkOS era keyed on auth.uid() — Supabase's
--    JWT-claim function. The app now authenticates via WorkOS over a
--    plain Postgres connection with no Supabase session, so auth.uid()
--    always evaluates NULL there and these policies always deny. Under
--    the current postgres/BYPASSRLS connection this is invisible (RLS is
--    skipped entirely); under continuum_app it would return ZERO ROWS
--    for these five tables, including api_keys — which the auth
--    middleware itself queries on every single request. That's a full
--    outage the moment the connection is switched, not a partial one.
--    Replaced with the same session-variable tenant_isolation pattern
--    already used everywhere else (accounts, campaigns, contacts, ...).
--
-- 2. bulk_job_emails, monitor_checks, webhook_deliveries, webhook_attempts,
--    smtp_cache had RLS *enabled* with no policy defined at all — Postgres
--    denies by default in that state, so these would also go silently
--    empty under continuum_app. Given policies scoped through their
--    parent via the same join pattern already used for campaign_recipients
--    (-> campaigns) and sequence_enrollments (-> sequences). smtp_cache is
--    the one deliberate exception: it's a cross-tenant shared cache by
--    design (see its own schema.prisma comment), so it gets an
--    allow-all policy rather than a tenant scope.
--
-- Idempotent: safe to run against a live database, safe to re-run.

DROP POLICY IF EXISTS "Users see own api_keys" ON api_keys;
DROP POLICY IF EXISTS "Users can see own api_keys" ON api_keys;
DROP POLICY IF EXISTS "Users can see own bulk_jobs" ON bulk_jobs;
DROP POLICY IF EXISTS "monitors_all" ON monitors;
DROP POLICY IF EXISTS "Users can select own monitors" ON monitors;
DROP POLICY IF EXISTS "Users can insert own monitors" ON monitors;
DROP POLICY IF EXISTS "Users can see own verifications" ON verifications;
DROP POLICY IF EXISTS "Users can select own webhooks" ON webhooks;
DROP POLICY IF EXISTS "webhooks_all" ON webhooks;
DROP POLICY IF EXISTS "Users can insert own webhooks" ON webhooks;

-- Deliberately just a self-match on id, not the ownerId/userId sibling-key
-- visibility that routes/api-keys/index.ts implements at the app level
-- (an account can see keys it doesn't itself authenticate as). Getting
-- that sibling logic right inside a policy risks a subtle leak on the
-- single most sensitive table in the schema (keyRaw lives here); every
-- api-keys route already does its own explicit ownerId/userId check
-- before acting, so those routes are expected to use withRlsBypass, same
-- as suppressions' bulk-check path — not to lean on this policy to widen
-- access. This policy's only job is: never return a DIFFERENT account's
-- key by accident when context isn't deliberately bypassed.
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON api_keys FOR ALL USING (
    id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON bulk_jobs FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON monitors FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON verifications FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON webhooks FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON bulk_job_emails FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM bulk_jobs b
      WHERE b.id = bulk_job_emails."bulkJobId"
        AND b."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON monitor_checks FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM monitors m
      WHERE m.id = monitor_checks."monitorId"
        AND m."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON webhook_deliveries FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM webhooks w
      WHERE w.id = webhook_deliveries."webhookId"
        AND w."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON webhook_attempts FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d."webhookId"
      WHERE d.id = webhook_attempts."deliveryId"
        AND w."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Deliberately global — see schema.prisma's own comment on SmtpCache.
DO $$ BEGIN
  CREATE POLICY shared_cache ON smtp_cache FOR ALL USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

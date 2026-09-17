-- Enables RLS on the three org-scoped tables deliberately deferred from the
-- rest of the 2026-09-17 pass (see docs/RLS-HARDENING-PUNCHLIST.md's "needs
-- its own design decision" section): org_members, org_settings, audit_logs.
-- Also widens the existing api_keys policy to add an org-based access path.
--
-- New session variable: app.current_org_id, set by withOrgTenant() in
-- src/lib/tenantContext.ts, mirroring app.current_api_key_id/withTenant().
--
-- org_members / org_settings: straightforward org_id match, same shape as
-- every apiKeyId-scoped policy already live.
--
-- audit_logs: rows are scoped by EITHER api_key_id OR org_id (never both —
-- app code sets one or the other, never both in the same row), and both
-- columns are nullable. This is NOT the "OR column IS NULL" shared/global
-- shape used for suppressions/soft_bounce_tracks: a null api_key_id here
-- means "this row is org-scoped," not "this row is shared with everyone" —
-- treating it as shared would leak every org's audit trail to any apiKeyId
-- tenant. So each side of the OR requires its own column to be NOT NULL
-- and matching, with no fallback for the other context's null case.
--
-- api_keys: the existing tenant_isolation policy (from
-- 20260916_fix_rls_policy_gaps) only allowed a self-id match, which is
-- exactly right for the apiKeyId-authenticated path but blocks the
-- org-admin dashboard's GET/DELETE /org/api-keys routes (routes/org/index.ts),
-- which look up keys by orgId with no apiKeyId in context at all. Widening
-- to add an org_id match: an org admin can only ever reach a key that
-- belongs to their own org (orgId is looked up from their verified WorkOS
-- session, same as every other withOrgTenant call site), so this does not
-- widen access beyond what routes/org/index.ts already intends to allow.
--
-- No-op today — DATABASE_URL still connects as the BYPASSRLS `postgres`
-- role on every service, same as every other migration in this pass.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON org_members FOR ALL USING (
    "org_id" = current_setting('app.current_org_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON org_settings FOR ALL USING (
    "org_id" = current_setting('app.current_org_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON audit_logs FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR ("api_key_id" IS NOT NULL AND "api_key_id" = current_setting('app.current_api_key_id', true))
    OR ("org_id" IS NOT NULL AND "org_id" = current_setting('app.current_org_id', true))
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DROP POLICY IF EXISTS tenant_isolation ON api_keys;
CREATE POLICY tenant_isolation ON api_keys FOR ALL USING (
  id = current_setting('app.current_api_key_id', true)
  OR current_setting('app.rls_bypass', true) = 'true'
  OR ("org_id" IS NOT NULL AND "org_id" = current_setting('app.current_org_id', true))
);

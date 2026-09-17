-- Enables RLS on team_invites and team_members. Scoping column here is
-- workspaceKeyId, not apiKeyId (a team invite/membership row belongs to
-- the WORKSPACE it was issued for, not the member's own key).
--
-- No-op today, same as 20260917_rls_connectors_salesforce — see that
-- migration's comment for why. Application code in
-- src/routes/team/index.ts (real apiKeyId context — withTenant) and
-- src/routes/auth/index.ts (identity discovery before any tenant is
-- known — withRlsBypass) was updated in the same commit.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON team_invites FOR ALL USING (
    "workspaceKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON team_members FOR ALL USING (
    "workspaceKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

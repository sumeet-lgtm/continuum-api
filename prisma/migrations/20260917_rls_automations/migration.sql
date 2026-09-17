-- Enables RLS on automations, automation_steps (child, via automation_id
-- join), and automation_enrollments (child, via automation_id join).
-- Column names here are snake_case throughout (unlike most of the
-- schema) — Automation/AutomationStep/AutomationEnrollment all use
-- explicit @map. No-op today, same as the other 2026-09-17 RLS
-- migrations.
--
-- Application code updated in the same commit: src/routes/automations/
-- index.ts (every route), src/workers/automationWorker.ts (the due-
-- enrollments scan is a genuine cross-tenant sweep — withRlsBypass, each
-- row's own automation.apiKeyId re-scopes everything downstream via
-- withTenant), src/routes/privacy/index.ts (found two additional real
-- gaps here — a verification.deleteMany and an automationEnrollment.
-- deleteMany that were textually inside a withTenant() callback but
-- called through the plain `prisma` client instead of the callback's own
-- `tx`, silently escaping the transaction entirely).
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_enrollments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON automations FOR ALL USING (
    api_key_id = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON automation_steps FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = automation_steps.automation_id
        AND a.api_key_id = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON automation_enrollments FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = automation_enrollments.automation_id
        AND a.api_key_id = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

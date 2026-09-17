-- Enables RLS on email_templates and email_template_versions (child, via
-- templateId join). No-op today, same as the other 2026-09-17 RLS
-- migrations.
--
-- Application code updated in the same commit: src/routes/templates/index.ts,
-- src/routes/connectors/payment.ts (one read), src/routes/send/index.ts.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template_versions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON email_templates FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON email_template_versions FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM email_templates t
      WHERE t.id = email_template_versions."templateId"
        AND t."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

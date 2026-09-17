-- Enables RLS on sequence_steps (child, via sequenceId join to
-- sequences.apiKeyId) and sequence_variants (grandchild — variant ->
-- step -> sequence -> apiKeyId, a two-level join). `sequences` itself
-- already has RLS (from the original rollout). No-op today, same as
-- the other 2026-09-17 RLS migrations.
--
-- Application code updated in the same commit: src/routes/sequences/
-- index.ts (every step/variant route — several call sites were doing
-- an ownership check inside withTenant() but then the actual
-- read/write on the bare `prisma` client afterward, outside any
-- transaction), src/routes/analytics/index.ts (two calls, one of which
-- was already textually inside a withTenant() callback and just needed
-- `tx` instead of `prisma`).
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_variants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON sequence_steps FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM sequences s
      WHERE s.id = sequence_steps."sequenceId"
        AND s."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON sequence_variants FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM sequence_steps st
      JOIN sequences s ON s.id = st."sequenceId"
      WHERE st.id = sequence_variants."stepId"
        AND s."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

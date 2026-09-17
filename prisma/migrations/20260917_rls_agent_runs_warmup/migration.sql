-- Enables RLS on agent_runs, agent_run_events (child, via agentRunId join),
-- and warmup_configs (child, via mailboxId join) — the flagship 5-agent
-- feature's own state, plus the mailbox warmup ramp config it can adjust.
-- No-op today, same as the other 2026-09-17 RLS migrations.
--
-- Application code updated in the same commit:
--   src/routes/agentRuns/index.ts, src/workers/agentRunWorker.ts (the
--   biggest single file in this pass — every tick handler across all 5
--   pillars converted; the due-runs scan uses withRlsBypass, everything
--   else withTenant(run.apiKeyId, ...); emitEvent()'s signature changed
--   to take the whole AgentRunRecord instead of just its id, so it can
--   scope its own agent_run_events writes),
--   src/lib/nurtureAgent.ts, src/lib/outboundAgent.ts (both had one
--   currently-uncalled function each — fixed for correctness anyway),
--   src/routes/mailboxes/index.ts, src/workers/warmupWorker.ts (its
--   top-level "every enabled warmup config" scan is a genuine
--   cross-tenant read by design — the pool deliberately pairs mailboxes
--   across different customers — so that one uses withRlsBypass too).
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_configs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON agent_runs FOR ALL USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON agent_run_events FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM agent_runs r
      WHERE r.id = agent_run_events.agent_run_id
        AND r."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON warmup_configs FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM mailboxes m
      WHERE m.id = warmup_configs."mailboxId"
        AND m."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

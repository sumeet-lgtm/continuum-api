-- Enables RLS on tracking_events and send_events, both children of
-- send_messages (which already has RLS from the original rollout) via
-- sendMessageId. tracking_events.sendMessageId is nullable in the
-- schema, but every actual write site (track/index.ts's open/click
-- pixel handlers, accountData.ts) always sets it — a null-sendMessageId
-- row is not a real, expected case, so the policy simply hides such a
-- row from every tenant-scoped query (safe default; nothing legitimate
-- should ever need to see one). send_events.sendMessageId is NOT
-- nullable.
--
-- No-op today, same as the other 2026-09-17 RLS migrations.
--
-- Application code updated in the same commit (the largest single
-- sweep in this pass — ~30 call sites across 10 files):
--   src/routes/track/index.ts (public, unauthenticated pixel/redirect
--     endpoint — withRlsBypass for the token->tenant lookup, withTenant
--     once the tenant is known),
--   src/engine/botDetection.ts (the IP-fanout scanner check is
--     deliberately cross-tenant by design — withRlsBypass),
--   src/workers/sequenceWorker.ts (evaluateCondition's signature gained
--     an apiKeyId parameter),
--   src/routes/send/events.ts, src/routes/send/smtp2goEvents.ts
--     (SES/SMTP2GO webhook handlers — apiKeyId resolved via the
--     existing sendMessage lookup, already withRlsBypass'd),
--   src/routes/analytics/index.ts, src/routes/contacts/index.ts,
--     src/routes/messages/index.ts, src/routes/lists/index.ts,
--     src/routes/campaigns/index.ts, src/routes/sequences/index.ts.
--
-- lists/index.ts's two hygiene-report queries got an additional real
-- fix beyond RLS-readiness: they filtered trackingEvent by email alone
-- with no apiKeyId/sendMessage scoping at all, so a different tenant's
-- send to the same address could have counted toward this tenant's
-- engagement bucketing. Added the missing `sendMessage: { apiKeyId }`
-- filter explicitly, not just relying on RLS to catch it later.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON tracking_events FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM send_messages m
      WHERE m.id = tracking_events."sendMessageId"
        AND m."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON send_events FOR ALL USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM send_messages m
      WHERE m.id = send_events."sendMessageId"
        AND m."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

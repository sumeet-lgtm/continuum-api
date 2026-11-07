-- RECORD ONLY — ALREADY APPLIED TO PRODUCTION OUT-OF-BAND (Sep 14 2026).
-- This file was recovered on 2026-11-07 from the standalone staging folder
-- (continuum-deploy-rls-staging) and committed so the repo holds the complete
-- RLS history. See 20260915_continuum_app_role, which refers to it.
--
-- DO NOT RE-RUN: the policies below have no IF NOT EXISTS guards, so running
-- it again fails with "policy already exists". If `prisma migrate deploy`
-- complains about it, mark it applied instead of running it:
--   npx prisma migrate resolve --applied 20260914_row_level_security
-- (run-migration.mjs ignores subdirectory migrations, so nothing auto-applies it.)
--
-- Row-Level Security: database-enforced tenant isolation.
--
-- Application-code scoping (apiKeyId in every WHERE clause) is discipline,
-- not a guarantee — the 2026-09-14 incident and three related bugs found
-- in the same review all existed because a query simply omitted it. RLS
-- makes the missing filter physically incapable of returning another
-- tenant's rows: Postgres itself refuses, regardless of what the query
-- asked for.
--
-- Mechanism: every tenant-scoped query must run inside a transaction that
-- first sets `app.current_api_key_id` via SET LOCAL (see
-- src/lib/tenantContext.ts — this migration alone does nothing until the
-- app is wired to set that variable; see rollout notes at the bottom).
-- With no session variable set, current_setting(..., true) returns NULL,
-- every policy comparison against NULL is false, and RLS denies by
-- default — fail-closed, not fail-open.
--
-- A second variable, `app.rls_bypass`, is an explicit, auditable escape
-- hatch for the legitimate "sweep every tenant's due work, each row uses
-- its own apiKeyId downstream" pattern already used by several workers
-- (sequenceWorker's dueEnrollments, bulkWorker's stalled-job sweep,
-- scheduledChecks' A/B test sweep). Only worker entry points may set it;
-- no request-handling code path ever should.
--
-- Phase 1 scope: the tables in the actual blast radius of the incident
-- and the three related bugs — the models a compromised or buggy query
-- here directly leaks contactable PII or sends email to the wrong
-- account. The remaining ~15 apiKeyId-bearing tables (AuditLog,
-- ApiRequestLog, Monitor, Webhook, SoftBounceTrack, SendingDomain,
-- EmailTemplate, InboxTest, SalesforceConnection, SalesforceLeadSync,
-- AutomationEnrollment, TrackingEvent, SequenceStep) are lower-severity
-- (operational/audit data, not send-recipient data) and are a deliberate
-- phase 2, not skipped by oversight.

-- Direct apiKeyId tables -----------------------------------------------

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contacts"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "mailing_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailing_lists" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mailing_lists"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leads"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "accounts"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sequences"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaigns"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "send_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "send_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "send_messages"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mailboxes"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "segments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "segments"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR current_setting('app.rls_bypass', true) = 'true'
  );

-- Suppression.apiKeyId is nullable: NULL means a platform-wide
-- suppression (e.g. a known spamtrap or role address) that must stay
-- visible to every tenant's send, not just one account's.
ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppressions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "suppressions"
  USING (
    "apiKeyId" = current_setting('app.current_api_key_id', true)
    OR "apiKeyId" IS NULL
    OR current_setting('app.rls_bypass', true) = 'true'
  );

-- Relation-scoped tables (no direct apiKeyId column) --------------------
-- These are exactly the shape of the actual bugs found this session:
-- ContactListMembership is the table the 2026-09-14 incident leaked
-- through.

ALTER TABLE "contact_list_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_list_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contact_list_memberships"
  USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "contacts" c
      WHERE c.id = "contact_list_memberships"."contactId"
        AND c."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );

ALTER TABLE "sequence_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequence_enrollments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sequence_enrollments"
  USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "sequences" s
      WHERE s.id = "sequence_enrollments"."sequenceId"
        AND s."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );

ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_recipients"
  USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "campaigns" c
      WHERE c.id = "campaign_recipients"."campaignId"
        AND c."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );

ALTER TABLE "reply_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reply_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reply_events"
  USING (
    current_setting('app.rls_bypass', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "mailboxes" m
      WHERE m.id = "reply_events"."mailboxId"
        AND m."apiKeyId" = current_setting('app.current_api_key_id', true)
    )
  );

-- Rollout notes ----------------------------------------------------------
-- 1. This migration is safe to apply on its own: FORCE ROW LEVEL SECURITY
--    applies to every role including the table owner, so once applied,
--    ANY query that doesn't set app.current_api_key_id (or app.rls_bypass)
--    will see zero rows on these 12 tables — including the app's own
--    Prisma connection, until it's wired to set the session variable.
--    Applying this before the app is wired WILL take the product down.
-- 2. Required before this can go live: every request-handling code path
--    (Fastify route handlers) and every worker's per-tenant operation
--    must run its Prisma calls inside prisma.$transaction(async (tx) => {
--    await tx.$executeRawUnsafe(`SET LOCAL app.current_api_key_id = '${apiKeyId}'`);
--    ... }) — see src/lib/tenantContext.ts for the withTenant() helper
--    that does this. That is a real refactor across every route file and
--    is NOT done by this migration alone.
-- 3. Workers doing a legitimate cross-tenant sweep set app.rls_bypass
--    instead, then re-scope to the specific row's own apiKeyId (via
--    withTenant) for every subsequent per-row operation.

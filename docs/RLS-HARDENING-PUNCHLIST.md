# RLS Hardening Punch List

## Context

RLS is not currently enforced anywhere in production. Every Railway service's `DATABASE_URL` connects as the `postgres` role, which has `BYPASSRLS=true`. A correctly-configured, non-bypassing role (`continuum_app`) was created on 2026-09-15 (`prisma/migrations/20260915_continuum_app_role`) specifically so `DATABASE_URL` could be switched to it, but no service has been cut over yet.

The reason it was never flipped: a large number of routes and workers query RLS-eligible tables through the plain Prisma client instead of `withTenant()`/`withRlsBypass()` (see `src/lib/tenantContext.ts`). Those wrappers are what set the Postgres session variable (`app.current_api_key_id` / `app.rls_bypass`) the RLS policies check. A query that doesn't go through one of them gets **zero rows** the moment RLS is actually enforced — not a leak, but a silent feature outage. Enabling RLS without first fixing every call site on a given table would break that table's features across all 8 services at once, with no staging environment to catch it first.

**Done so far (2026-09-17):**
- `accountData.ts` (GDPR export/delete) — fixed to use `tx` for monitor/webhook/automation/verification/bulkJob/monitorCheck/webhookDelivery/sendingDomain/emailTemplate/inboxTest/trackingEvent/automationEnrollment.
- `contacts/index.ts` double opt-in confirmation — fixed to use `withRlsBypass()` for the tenant-discovery lookup.
- `connector_secrets`, `connector_rules`, `connector_events`, `salesforce_connections`, `salesforce_lead_syncs` — RLS enabled, policies live, every call site in `payment.ts`/`salesforce.ts`/`salesforceSyncWorker.ts` converted.
- `team_invites`, `team_members` — RLS enabled, policies live. `team/index.ts` converted to `withTenant()` (real apiKeyId at every call site). `auth/index.ts` converted to `withRlsBypass()` instead — every apiKey/teamMember/teamInvite call there happens during login/identity discovery, before any tenant is known. This is the highest-risk file touched (breaks login if wrong) — verified live: dashboard loads authenticated, `/v1/team` and `/v1/team/invites` both return correct 200s post-deploy.
- `inbox_tests`, `brand_kits`, `api_request_logs` — RLS enabled, policies live. All single apiKeyId-scoped, request-scoped call sites; `server.ts`'s fire-and-forget request-logging hook also converted.
- `sending_domains` — RLS enabled, policy live. `domainVerify.ts` (shared by the manual verify route and the worker), `domainVerifyWorker.ts` (`withRlsBypass()` for the cross-tenant "every pending domain" scan), `domains/index.ts`, `send/index.ts`, `analytics/index.ts` (one call) all converted. Also fixed two test files whose prisma mocks didn't implement `$transaction` — now the established `prisma.$transaction = vi.fn((fn) => fn(prisma))` pattern.
- `agent_runs`, `agent_run_events`, `warmup_configs` — RLS enabled, policies live. Biggest single file in the pass: `agentRunWorker.ts`'s 5 pillar tick handlers (verification/nurture/lead_finding/warmup/outbound) all converted; `emitEvent()`'s signature changed to take the whole run record instead of just its id, updated at all 16 call sites. `warmupWorker.ts`'s top-level scan is deliberately cross-tenant (the pool pairs mailboxes across customers by design) — `withRlsBypass()`, not a gap. First migration attempt had a wrong column name (missed a `@map`), failed cleanly inside its own transaction, recovered via `prisma migrate resolve --rolled-back`, fixed, reapplied. **Verified live end-to-end**: created a real agent run via the API (using the dashboard's own session, not a hardcoded key), confirmed it persisted through a fresh list call, PATCH-paused it, cancelled it, cleaned up test data — all against the deployed RLS-hardened code.

**Not done:** everything below. None of it is urgent in the sense of "actively leaking" — app-level `WHERE apiKeyId` filters are still the only protection either way, exactly as before this pass started. It's about making the eventual role cutover safe, not about an active vulnerability.

- `email_templates`, `email_template_versions` — RLS enabled, policies live. `templates/index.ts` (every route), `connectors/payment.ts` (one read, previously left plain on purpose pending this), `send/index.ts` converted.
- `automations`, `automation_steps`, `automation_enrollments` — RLS enabled, policies live (note: this table family uses snake_case `@map`s throughout, unlike most of the schema — double-checked every column against schema.prisma before writing SQL this time). `automations/index.ts`, `automationWorker.ts` (cross-tenant sweep via `withRlsBypass()`) converted. Bonus find: `privacy/index.ts` had two calls textually inside a `withTenant()` callback that used the plain `prisma` client instead of the callback's own `tx` — silently escaping the transaction (and, for `verification`, escaping RLS scope on an already-protected table). Fixed both.
- `sequence_steps`, `sequence_variants` — RLS enabled, policies live (`sequence_variants` is a two-level join: variant → step → sequence → apiKeyId). `sequences/index.ts` had a recurring pattern of a correctly-scoped ownership check followed by the actual read/write on the bare client, unscoped — fixed at every occurrence. `analytics/index.ts` had two more, one already inside a `withTenant()` callback needing only `tx` instead of `prisma`.
- `tracking_events`, `send_events` — RLS enabled, policies live. The largest single sweep in the whole pass — ~30 call sites across 10 files (`track/index.ts`'s public pixel/click endpoints, `botDetection.ts`'s deliberately-cross-tenant IP-fanout check, `sequenceWorker.ts`, both SES/SMTP2GO webhook handlers, `analytics/`, `contacts/`, `messages/`, `lists/`, `campaigns/`, `sequences/` index.ts). Bonus find in `lists/index.ts`: two hygiene-report queries filtered by email alone with zero tenant scoping — a different customer's send to the same address could have counted toward this tenant's engagement bucketing; added the missing `sendMessage: { apiKeyId }` filter explicitly. Attempted a full live pixel-open test (real send → real signed token → hit `/track/open`) but my local `.env` was missing the dedicated `TRACKING_SECRET` Railway has set, so the token I generated didn't verify — confirmed as my own tooling gap, not a bug (the endpoint correctly rejected the bad signature without touching the DB, which is itself reassuring fail-safe behavior). Not re-attempted; relying on code review + the identical pattern already proven live on team/agent-runs instead.
- `bulkJob`/`bulkJobEmail` app-code gaps in `finder/index.ts` (6 calls) and `bulkWorker.ts` (4 calls) — no new migration needed, `bulk_jobs`/`bulk_job_emails` already had RLS from the original rollout; this closed the last app-code gaps from the initial 17-gap sweep.

**This closes every item that was on the original "remaining tables" list.** What's left is described below — both deliberately deferred, not overlooked.

## Explicitly out of scope for this pass — needs its own design decision first

- **`audit_logs`, `org_members`, `org_settings`** — scoped by `orgId` (WorkOS SSO), not `apiKeyId`. No session variable exists for org-scoped RLS today; introducing one is a small architecture decision (new `app.current_org_id` session var + a second policy shape), not a mechanical fix. `audit_logs` additionally mixes both nullable `apiKeyId` and nullable `orgId` per row — the safe policy is *not* the same "OR apiKeyId IS NULL" shape used for `suppressions`, since a null-apiKeyId audit row here means "org-scoped," not "shared/global," and exposing it to any apiKeyId tenant would be a real leak. Do this table last, carefully, on its own.

## Correctly excluded — not gaps, verified during this pass

- `suppressions`, `soft_bounce_tracks` — deliberately global/shared (nullable `apiKeyId` means "who caused it," not "who owns it"); already has the correct exception-shaped policy.
- `smtp_cache`, `domain_catchall_cache` — deliberately shared cache across all tenants, by schema comment.
- `sequence_templates` — a curated shared library, no `apiKeyId` field at all.
- `status_subscribers` — public status-page email list, not tenant data (and has no Prisma model — raw SQL only, in `public-status.ts`).

## The cutover itself (do this last, after everything above is done and tested)

1. Confirm zero remaining plain `prisma.<model>.` calls on any RLS-enabled table:
   ```
   grep -rn "prisma\.\(<every RLS model name>\)\." src --include="*.ts" | grep -v __tests__
   ```
2. Run the full test suite and a full manual smoke pass across every major flow (verify, bulk, campaigns, sequences, team, billing, connectors, Salesforce, agent runs) — there's no staging environment, so this has to be thorough.
3. Switch `DATABASE_URL` to the `continuum_app` role on **one low-traffic worker first** (e.g. `worker-webhook` or `smtp-relay`), not `web`. Watch logs closely for a few minutes.
4. Roll to the remaining workers one at a time, `web` last (highest blast radius, most call sites).
5. Once fully cut over, verify the actual security property empirically: create a second test API key, confirm it cannot read the first key's contacts/leads/suppressions/etc. even with a manually-crafted request that omits a `WHERE apiKeyId` filter (this is the real proof RLS is doing something — everything before this step is prep).

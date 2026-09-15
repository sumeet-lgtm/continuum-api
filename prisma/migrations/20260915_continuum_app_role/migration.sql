-- Restricted, non-superuser, NOBYPASSRLS Postgres role for the app's
-- runtime connection. Created because the app currently connects as
-- Supabase's default `postgres` role, which has BYPASSRLS=true — making
-- every RLS policy (see 20260914_row_level_security, applied out-of-band)
-- a complete no-op regardless of FORCE ROW LEVEL SECURITY. This role is
-- what DATABASE_URL moves to (per-service, one at a time — see the
-- rollout plan), while DIRECT_URL stays on `postgres` for DDL (prisma
-- migrate deploy).
--
-- APPLIED 2026-09-15 by hand (a standalone script generating a random
-- password via `openssl rand -base64 32`, never committed here) — not
-- picked up by run-migration.mjs's automatic loop (lives in its own
-- timestamped subdirectory, which that script never scans), and marked
-- resolved via `prisma migrate resolve --applied` so `prisma migrate
-- deploy` (which DOES scan this directory, and runs on every `web` boot)
-- treats it as already-done rather than re-running CREATE ROLE and
-- crashing on "role already exists".
--
-- This file is a historical record of what was applied, not a script to
-- re-run — CREATE ROLE with a real password is intentionally not
-- reproduced here.

CREATE ROLE continuum_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 50
  PASSWORD '<redacted — generated fresh via openssl rand -base64 32, stored only in Railway env vars>';

GRANT USAGE ON SCHEMA public TO continuum_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO continuum_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO continuum_app;

-- Every future `prisma migrate deploy` (run by `postgres` via DIRECT_URL)
-- auto-extends these same grants to any NEW table, so this isn't repeated
-- by hand on every future migration.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO continuum_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO continuum_app;

-- Deliberately NOT granted: CREATE on schema public, any DDL, BYPASSRLS,
-- superuser. This role can read/write existing rows, nothing else.

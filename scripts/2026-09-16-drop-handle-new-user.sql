-- Removes the dead Supabase-Auth-era signup trigger.
-- Applied to prod (ghdkanhhfhxfbskszuqk) on 2026-09-16.
--
-- handle_new_user() (see scripts/handle-new-user.sql) fired on auth.users
-- INSERT and provisioned a free-plan api_keys row + a public.profiles row.
-- profiles was never actually created, so the insert into it always failed —
-- and because both inserts live in the same BEGIN...EXCEPTION block, that
-- failure rolled back the api_keys insert too (Postgres exception handlers
-- roll back to the implicit savepoint at BEGIN), silently, since the
-- handler swallows the error and returns NEW regardless.
--
-- This never caused a real incident because Supabase Auth signup has been
-- fully replaced by WorkOS (see src/routes/auth/index.ts) — the live signup
-- page only offers Google OAuth / company SSO through api.continuumapi.com's
-- own /auth routes, and auth.users had taken zero new rows since 2026-08-07.
-- Dropping outright rather than fixing the profiles reference: there's no
-- live path left that inserts into auth.users, so there's nothing left for
-- this trigger to do.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

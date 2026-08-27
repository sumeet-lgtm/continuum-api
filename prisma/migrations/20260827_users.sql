-- Users table for WorkOS SSO authentication
-- Run via: railway run npx prisma migrate deploy
-- Or manually via: psql $DATABASE_URL < prisma/migrations/20260827_users.sql

CREATE TABLE IF NOT EXISTS users (
  id           TEXT NOT NULL PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  email        TEXT NOT NULL UNIQUE,
  workos_id    TEXT UNIQUE,
  first_name   TEXT,
  last_name    TEXT,
  org_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx    ON users (email);
CREATE INDEX IF NOT EXISTS users_workos_id_idx ON users (workos_id);

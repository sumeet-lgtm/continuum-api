-- Migration: api_request_logs
-- Adds a best-effort table for logging every authenticated API call.
-- Written fire-and-forget in an onResponse hook; retention is 30 days.

CREATE TABLE IF NOT EXISTS api_request_logs (
  id           TEXT        NOT NULL PRIMARY KEY,
  api_key_id   TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  method       TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  status_code  INTEGER     NOT NULL,
  duration_ms  INTEGER     NOT NULL,
  source_ip    TEXT,
  request_id   TEXT,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_request_logs_api_key_created
  ON api_request_logs (api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS api_request_logs_created
  ON api_request_logs (created_at DESC);

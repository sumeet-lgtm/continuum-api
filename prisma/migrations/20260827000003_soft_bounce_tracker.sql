-- Soft bounce tracker: count transient bounces per email, suppress after 3 strikes
CREATE TABLE soft_bounce_tracks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email           TEXT NOT NULL UNIQUE,
  api_key_id      TEXT,
  bounce_count    INTEGER NOT NULL DEFAULT 1,
  last_bounce_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_soft_bounce_tracks_email ON soft_bounce_tracks(email);

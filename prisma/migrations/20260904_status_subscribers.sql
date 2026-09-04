-- Status page email subscribers
CREATE TABLE IF NOT EXISTS status_subscribers (
  email      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Brand Kit: per-API-key brand settings (logo, color, font, footer, from name)
CREATE TABLE IF NOT EXISTS brand_kits (
  id            TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  api_key_id    TEXT        NOT NULL UNIQUE REFERENCES api_keys(id) ON DELETE CASCADE,
  logo_url      TEXT,
  primary_color TEXT        NOT NULL DEFAULT '#000000',
  font_family   TEXT        NOT NULL DEFAULT 'Arial, sans-serif',
  company_name  TEXT,
  from_name     TEXT,
  footer_text   TEXT,
  website_url   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_kits_api_key_id_idx ON brand_kits(api_key_id);

-- Connector secrets: stores webhook signing secrets per connector (Stripe, Chargebee, etc.)
CREATE TABLE IF NOT EXISTS connector_secrets (
  id          TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  api_key_id  TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  connector   TEXT        NOT NULL,
  secret      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(api_key_id, connector)
);

CREATE INDEX IF NOT EXISTS connector_secrets_api_key_id_idx ON connector_secrets(api_key_id);

-- Connector rules: maps event_type → action (send_template | enroll_sequence)
CREATE TABLE IF NOT EXISTS connector_rules (
  id          TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  api_key_id  TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  connector   TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  action      TEXT        NOT NULL DEFAULT 'send_template',
  template_id TEXT,
  sequence_id TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(api_key_id, connector, event_type)
);

CREATE INDEX IF NOT EXISTS connector_rules_api_key_id_idx ON connector_rules(api_key_id);

-- Connector events: log of every incoming payment/CRM event
CREATE TABLE IF NOT EXISTS connector_events (
  id          TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  api_key_id  TEXT        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  connector   TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  normalized  JSONB       NOT NULL DEFAULT '{}',
  status      TEXT        NOT NULL DEFAULT 'received',
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_events_api_key_created_idx ON connector_events(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connector_events_api_key_connector_idx ON connector_events(api_key_id, connector);

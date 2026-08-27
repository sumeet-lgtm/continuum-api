-- Email Automations: event-triggered drip sequences (Resend parity)

CREATE TABLE automations (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  api_key_id     TEXT NOT NULL REFERENCES api_keys(id),
  name           TEXT NOT NULL,
  trigger_event  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automations_api_key_id        ON automations(api_key_id);
CREATE INDEX idx_automations_api_key_trigger   ON automations(api_key_id, trigger_event);

CREATE TABLE automation_steps (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_order     INTEGER NOT NULL,
  delay_hours    INTEGER NOT NULL DEFAULT 0,
  subject        TEXT NOT NULL,
  html_body      TEXT NOT NULL,
  text_body      TEXT,
  from_name      TEXT,
  from_email     TEXT,
  domain_id      TEXT,
  UNIQUE(automation_id, step_order)
);

CREATE TABLE automation_enrollments (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  automation_id  TEXT NOT NULL REFERENCES automations(id),
  email          TEXT NOT NULL,
  data           JSONB,
  status         TEXT NOT NULL DEFAULT 'active',
  current_step   INTEGER NOT NULL DEFAULT 0,
  next_send_at   TIMESTAMPTZ,
  enrolled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  UNIQUE(automation_id, email)
);

CREATE INDEX idx_automation_enrollments_status_next ON automation_enrollments(status, next_send_at)
  WHERE status = 'active';

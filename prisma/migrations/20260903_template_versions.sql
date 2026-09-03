-- Template Version History
-- Every update to an EmailTemplate saves the prior state as a version snapshot.
-- Versions are immutable and cascade-delete when the template is deleted.

CREATE TABLE IF NOT EXISTS email_template_versions (
  id           TEXT        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "templateId" TEXT        NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  version      INTEGER     NOT NULL,
  name         TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  "htmlBody"   TEXT        NOT NULL,
  "textBody"   TEXT,
  variables    JSONB,
  "savedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "savedBy"    TEXT
);

CREATE INDEX IF NOT EXISTS idx_template_versions_template
  ON email_template_versions("templateId", version DESC);

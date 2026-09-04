-- Salesforce two-way sync
CREATE TABLE IF NOT EXISTS salesforce_connections (
  id                TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  "apiKeyId"        TEXT        NOT NULL UNIQUE REFERENCES api_keys(id) ON DELETE CASCADE,
  "instanceUrl"     TEXT        NOT NULL,
  "refreshTokenEnc" TEXT        NOT NULL,
  "orgId"           TEXT,
  "connectedEmail"  TEXT,
  "syncEnabled"     BOOLEAN     NOT NULL DEFAULT true,
  "lastPushedAt"    TIMESTAMP(3),
  "lastPulledAt"    TIMESTAMP(3),
  "lastErrorMsg"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS salesforce_lead_syncs (
  id               TEXT        NOT NULL DEFAULT (gen_random_uuid())::text PRIMARY KEY,
  "apiKeyId"       TEXT        NOT NULL,
  "leadEmail"      TEXT        NOT NULL,
  "salesforceId"   TEXT        NOT NULL,
  "sfObjectType"   TEXT        NOT NULL DEFAULT 'Lead',
  "lastPushedAt"   TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lastSfStatus"   TEXT,
  "lastSfSyncedAt" TIMESTAMP(3),
  CONSTRAINT salesforce_lead_syncs_apikey_email_key UNIQUE ("apiKeyId", "leadEmail")
);

CREATE INDEX IF NOT EXISTS salesforce_lead_syncs_apikey_sfid_idx ON salesforce_lead_syncs("apiKeyId", "salesforceId");

-- Create accounts table
CREATE TABLE IF NOT EXISTS "accounts" (
  "id"         TEXT NOT NULL,
  "apiKeyId"   TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "domain"     TEXT,
  "industry"   TEXT,
  "employees"  INTEGER,
  "revenue"    TEXT,
  "website"    TEXT,
  "linkedin"   TEXT,
  "city"       TEXT,
  "country"    TEXT,
  "notes"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounts_apiKeyId_domain_key" UNIQUE ("apiKeyId", "domain"),
  CONSTRAINT "accounts_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "accounts_apiKeyId_idx" ON "accounts"("apiKeyId");

-- Add accountId to leads
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "accountId" TEXT;

ALTER TABLE "leads" ADD CONSTRAINT "leads_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "leads_accountId_idx" ON "leads"("accountId");

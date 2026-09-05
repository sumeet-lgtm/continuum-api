-- Domain-level catch-all cache — see the comment above the model in
-- schema.prisma for why this is separate from the per-email SmtpCache.
CREATE TABLE IF NOT EXISTS "domain_catchall_cache" (
  "id"          TEXT NOT NULL,
  "domain"      TEXT NOT NULL,
  "isCatchAll"  BOOLEAN NOT NULL,
  "checkedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "domain_catchall_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "domain_catchall_cache_domain_key" ON "domain_catchall_cache"("domain");
CREATE INDEX IF NOT EXISTS "domain_catchall_cache_expiresAt_idx" ON "domain_catchall_cache"("expiresAt");

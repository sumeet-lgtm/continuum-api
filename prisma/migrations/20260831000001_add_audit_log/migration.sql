-- logAudit() previously no-op'd entirely whenever orgId was null or
-- WORKOS_API_KEY was unset, so any customer not on the org/SSO flow had no
-- audit trail at all. This table is the local record written for every
-- audited action regardless of org/WorkOS configuration.

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT NOT NULL,
  "org_id" TEXT,
  "api_key_id" TEXT,
  "action" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_email" TEXT NOT NULL,
  "actor_ip" TEXT,
  "targets" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_org_id_idx" ON "audit_logs"("org_id");
CREATE INDEX IF NOT EXISTS "audit_logs_api_key_id_idx" ON "audit_logs"("api_key_id");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");

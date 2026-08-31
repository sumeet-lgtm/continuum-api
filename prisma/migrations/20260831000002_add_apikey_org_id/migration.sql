-- Previously nothing tied an API key to a WorkOS org at all — org
-- admin/member roles only governed the WorkOS-managed dashboard shell
-- (invites, role changes), not the actual product resources every key
-- owns. This is the column routes/org/index.ts's new api-keys endpoints
-- (and the SSO callback's key auto-provisioning) key off of.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "org_id" TEXT;

CREATE INDEX IF NOT EXISTS "api_keys_org_id_idx" ON "api_keys"("org_id");

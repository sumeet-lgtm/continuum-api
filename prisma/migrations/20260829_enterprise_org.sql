-- Enterprise org tables: OrgMember + OrgSettings

CREATE TABLE IF NOT EXISTS "org_members" (
    "id"            TEXT NOT NULL,
    "user_id"       TEXT NOT NULL,
    "org_id"        TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "role"          TEXT NOT NULL DEFAULT 'member',
    "email"         TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'active',
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_members_membership_id_key" ON "org_members"("membership_id");
CREATE UNIQUE INDEX IF NOT EXISTS "org_members_user_id_org_id_key" ON "org_members"("user_id", "org_id");
CREATE INDEX IF NOT EXISTS "org_members_org_id_idx" ON "org_members"("org_id");

ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "org_settings" (
    "id"           TEXT NOT NULL,
    "org_id"       TEXT NOT NULL,
    "name"         TEXT,
    "domain"       TEXT,
    "mfa_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_settings_org_id_key" ON "org_settings"("org_id");

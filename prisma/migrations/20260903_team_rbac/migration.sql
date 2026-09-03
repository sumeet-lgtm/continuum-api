-- Team members (shared workspace access)
CREATE TABLE IF NOT EXISTS "team_members" (
  "id"             TEXT NOT NULL,
  "workspaceKeyId" TEXT NOT NULL,
  "email"          TEXT NOT NULL,
  "role"           TEXT NOT NULL DEFAULT 'member',
  "invitedBy"      TEXT,
  "joinedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_members_workspaceKeyId_email_key" UNIQUE ("workspaceKeyId", "email"),
  CONSTRAINT "team_members_workspaceKeyId_fkey"
    FOREIGN KEY ("workspaceKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "team_members_email_idx" ON "team_members"("email");

-- Team invites (pending invite tokens)
CREATE TABLE IF NOT EXISTS "team_invites" (
  "id"             TEXT NOT NULL,
  "workspaceKeyId" TEXT NOT NULL,
  "inviteeEmail"   TEXT NOT NULL,
  "role"           TEXT NOT NULL DEFAULT 'member',
  "token"          TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "invitedBy"      TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_invites_token_key" UNIQUE ("token"),
  CONSTRAINT "team_invites_workspaceKeyId_fkey"
    FOREIGN KEY ("workspaceKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "team_invites_token_idx"        ON "team_invites"("token");
CREATE INDEX IF NOT EXISTS "team_invites_workspaceKeyId_idx" ON "team_invites"("workspaceKeyId");
CREATE INDEX IF NOT EXISTS "team_invites_inviteeEmail_idx"  ON "team_invites"("inviteeEmail");

-- Agent Runs: shared cross-pillar agentic execution primitive.
-- New tables only, plus two nullable columns on contacts — purely additive,
-- safe to run against a live database with no downtime.

DO $$ BEGIN
  CREATE TYPE "AgentPillar" AS ENUM ('verification', 'lead_finding', 'outbound', 'warmup', 'nurture');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "AgentRunStatus" AS ENUM ('draft', 'pending_approval', 'active', 'running', 'paused', 'completed', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id"                    TEXT NOT NULL,
  "apiKeyId"              TEXT NOT NULL,
  "pillar"                "AgentPillar" NOT NULL,
  "name"                  TEXT,
  "status"                "AgentRunStatus" NOT NULL DEFAULT 'draft',
  "config"                JSONB NOT NULL,
  "error_message"         TEXT,
  "intervalHours"         INTEGER,
  "next_check_at"         TIMESTAMP(3),
  "last_checked_at"       TIMESTAMP(3),
  "consecutive_failures"  INTEGER NOT NULL DEFAULT 0,
  "paused_at"             TIMESTAMP(3),
  "started_at"            TIMESTAMP(3),
  "completed_at"          TIMESTAMP(3),
  "created_by_email"      TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at"          TIMESTAMP(3),

  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "agent_run_events" (
  "id"           TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "event_type"   TEXT NOT NULL,
  "message"      TEXT NOT NULL,
  "data"         JSONB,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_agent_run_id_fkey"
    FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "agent_runs_apiKeyId_idx" ON "agent_runs"("apiKeyId");
CREATE INDEX IF NOT EXISTS "agent_runs_pillar_status_idx" ON "agent_runs"("pillar", "status");
CREATE INDEX IF NOT EXISTS "agent_runs_status_next_check_at_idx" ON "agent_runs"("status", "next_check_at");
CREATE INDEX IF NOT EXISTS "agent_run_events_agent_run_id_created_at_idx" ON "agent_run_events"("agent_run_id", "created_at");

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_verified_at" TIMESTAMP(3);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_verification_status" TEXT;

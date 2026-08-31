-- Phase 4: Monitoring enhancements

-- Track consecutive failures so the worker can auto-pause broken monitors
ALTER TABLE "monitors"
  ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pausedAt"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "tags"                TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "notifyOnAnyChange"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "failureReason"       TEXT;

-- Record where a MonitorCheck came from (scheduled tick vs manual recheck)
ALTER TABLE "monitor_checks"
  ADD COLUMN IF NOT EXISTS "source"    TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;

-- Index for quickly finding monitors that need rechecking
CREATE INDEX IF NOT EXISTS "monitors_active_next_check_idx"
  ON "monitors"("isActive", "nextCheckAt")
  WHERE "isActive" = true AND "pausedAt" IS NULL;

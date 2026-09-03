-- Multi-channel sequence steps: add type + task_note
ALTER TABLE "sequence_steps"
  ADD COLUMN IF NOT EXISTS "type"      TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS "taskNote"  TEXT;

-- subject/htmlBody already have NOT NULL — make them nullable to allow non-email steps
-- We handle this at the application layer (Zod validation), not DB level,
-- so existing email steps stay valid. No schema change needed for nullable.

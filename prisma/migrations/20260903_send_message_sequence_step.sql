-- Link SendMessage rows to the sequence step that generated them
-- Enables accurate per-step funnel analytics (opens/clicks/bounces by step)
ALTER TABLE "send_messages"
  ADD COLUMN IF NOT EXISTS "sequence_step_id" TEXT;

CREATE INDEX IF NOT EXISTS "send_messages_sequence_step_id_idx"
  ON "send_messages" ("sequence_step_id");

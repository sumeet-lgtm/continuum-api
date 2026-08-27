-- Subsequences: link a child sequence to a parent, with a trigger event
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS parent_sequence_id TEXT;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS trigger_event TEXT; -- REPLIED|OPENED|CLICKED|NOT_REPLIED_IN_DAYS|NOT_OPENED_IN_DAYS
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS trigger_delay_days INTEGER NOT NULL DEFAULT 0;

-- Stop conditions: stop sequence on open or click, not just reply
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS stop_on_open BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS stop_on_click BOOLEAN NOT NULL DEFAULT false;

-- Lead enrollment bypass flags
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS ignore_block_list BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS ignore_duplicate_in_other_sequences BOOLEAN NOT NULL DEFAULT false;

-- Warmup improvements: reply rate + daily ramp
ALTER TABLE warmup_configs ADD COLUMN IF NOT EXISTS reply_rate_pct INTEGER NOT NULL DEFAULT 20;
ALTER TABLE warmup_configs ADD COLUMN IF NOT EXISTS daily_ramp_up INTEGER NOT NULL DEFAULT 2;
ALTER TABLE warmup_configs ADD COLUMN IF NOT EXISTS last_ramp_date TEXT; -- ISO date string YYYY-MM-DD

-- Index for subsequence lookups
CREATE INDEX IF NOT EXISTS idx_sequences_parent ON sequences(parent_sequence_id);

-- Fix: our new migrations added snake_case columns but the DB convention is camelCase for non-mapped fields
-- Rename all new columns to camelCase to match existing columns (stopOnReply, trackClicks, sendDays etc.)

-- sequences table
ALTER TABLE sequences RENAME COLUMN stop_on_open TO "stopOnOpen";
ALTER TABLE sequences RENAME COLUMN stop_on_click TO "stopOnClick";
ALTER TABLE sequences RENAME COLUMN parent_sequence_id TO "parentSequenceId";
ALTER TABLE sequences RENAME COLUMN trigger_event TO "triggerEvent";
ALTER TABLE sequences RENAME COLUMN trigger_delay_days TO "triggerDelayDays";

-- sequence_enrollments table
ALTER TABLE sequence_enrollments RENAME COLUMN ignore_block_list TO "ignoreBlockList";
ALTER TABLE sequence_enrollments RENAME COLUMN ignore_duplicate_in_other_sequences TO "ignoreDuplicateInOtherSequences";

-- warmup_configs table
ALTER TABLE warmup_configs RENAME COLUMN reply_rate_pct TO "replyRatePct";
ALTER TABLE warmup_configs RENAME COLUMN daily_ramp_up TO "dailyRampUp";
ALTER TABLE warmup_configs RENAME COLUMN last_ramp_date TO "lastRampDate";

-- sending_domains table
ALTER TABLE sending_domains RENAME COLUMN tracking_domain TO "trackingDomain";

-- Fix index name for parentSequenceId
DROP INDEX IF EXISTS idx_sequences_parent;
CREATE INDEX IF NOT EXISTS idx_sequences_parent ON sequences("parentSequenceId");

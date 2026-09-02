-- Add mailboxId to SequenceEnrollment for thread coherence
-- Tracks which mailbox sent step 0 so all follow-ups use the same sender

ALTER TABLE "sequence_enrollments" ADD COLUMN "mailboxId" TEXT;

-- Migration: add greylisted column to verifications table
-- This records whether the SMTP probe received a 4xx greylisting response.
-- Default false preserves the meaning of all existing rows.

ALTER TABLE "verifications"
  ADD COLUMN IF NOT EXISTS "greylisted" BOOLEAN NOT NULL DEFAULT false;

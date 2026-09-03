-- Add tags array column to leads table
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}';

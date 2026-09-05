-- Finder gets its own guaranteed monthly lead-finding allowance, separate
-- from the general verification pool — see currentMonthFinderUsage's
-- comment in schema.prisma for why (a customer who bulk-verifies their own
-- list early in the month must never find themselves locked out of
-- lead-finding for the rest of it).
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "current_month_finder_usage" INTEGER NOT NULL DEFAULT 0;

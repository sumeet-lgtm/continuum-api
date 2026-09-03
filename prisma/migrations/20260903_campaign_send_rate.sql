-- Add drip send rate limit to campaigns
-- When set, campaignWorker paces sends to at most this many emails/hour
ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "send_rate_per_hour" INTEGER;

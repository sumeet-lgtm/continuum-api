-- Phase 6 follow-up: give send quota its own rollover timestamp.
--
-- The first cut of Phase 6 had requireMonthlySendQuota share api_keys.usageResetAt
-- with the pre-existing verify-quota check. That's a real bug, not a style
-- nit: whichever quota check runs first after a month boundary resets ITS
-- OWN counter and pushes usageResetAt to next month — the other counter's
-- `now >= resetAt` then never fires again until the following boundary,
-- silently freezing it at last month's value for the whole month. Splitting
-- the reset timestamp per counter removes the coupling entirely.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "sendUsageResetAt" TIMESTAMP(3) NOT NULL
    DEFAULT date_trunc('month', now() + interval '1 month');

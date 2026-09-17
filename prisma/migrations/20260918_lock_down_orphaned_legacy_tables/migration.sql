-- Locks down a set of orphaned PascalCase tables discovered during the
-- 2026-09-17 role cutover's follow-up audit: leftovers from before the
-- schema was renamed to snake_case @map names, never dropped. None of
-- them appear anywhere in the current schema.prisma or in any app code
-- (the Prisma client only ever queries the current snake_case tables via
-- @map) — these are dead, unreferenced tables sitting alongside the real
-- ones. Confirmed empty except "SequenceTemplate" (2 rows of non-
-- sensitive, curated template copy, no customer PII).
--
-- Not a live-data risk today, but a real one left unaddressed: Supabase's
-- PostgREST auto-API can expose any public-schema table to anon/
-- authenticated roles independent of whether RLS is on, so an orphaned
-- table with no RLS is a live, avoidable exposure surface even while
-- it's empty.
--
-- Enabling RLS with zero policies denies all access by default for every
-- non-superuser role (including continuum_app) — a safe, fully
-- reversible lock-down. Deliberately not a DROP TABLE: these are empty
-- and unreferenced, but dropping production tables without a live
-- confirmation step is a separate, one-way decision from simply closing
-- the exposure.
--
-- Idempotent: safe to run against a live database, safe to re-run.

ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactListMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboxTest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Mailbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MailingList" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReplyEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Segment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SendingDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SequenceEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SequenceStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SequenceTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrackingEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarmupConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_CampaignLists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_CampaignSegments" ENABLE ROW LEVEL SECURITY;

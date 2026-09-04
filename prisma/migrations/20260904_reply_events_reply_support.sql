-- Support sending an actual reply from the Unified Inbox: capture the
-- prospect's own Message-ID (for correct In-Reply-To/References threading)
-- and when we last replied to them.
ALTER TABLE "reply_events" ADD COLUMN IF NOT EXISTS "messageId" TEXT;
ALTER TABLE "reply_events" ADD COLUMN IF NOT EXISTS "repliedAt" TIMESTAMP(3);

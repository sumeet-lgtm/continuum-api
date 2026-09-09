-- SMTP2GO fallback send transport — see src/lib/smtp2go.ts. Mirrors
-- sesMessageId: the webhook handler at /v1/send/smtp2go-events/:token
-- correlates inbound bounce/spam/delivered events back to a SendMessage row
-- by this id.
ALTER TABLE "send_messages" ADD COLUMN IF NOT EXISTS "smtp2goMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "send_messages_smtp2goMessageId_key" ON "send_messages"("smtp2goMessageId");
CREATE INDEX IF NOT EXISTS "send_messages_smtp2goMessageId_idx" ON "send_messages"("smtp2goMessageId");

-- Full Platform Parity Migration
-- Adds: custom domains, templates, tracking, mailing lists, contacts,
--       segments, campaigns, mailboxes, warmup, sequences, leads, inbox tests

-- ─── Extend ApiKey ────────────────────────────────────────────────────────────
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "name" TEXT,
  ADD COLUMN IF NOT EXISTS "permission" TEXT NOT NULL DEFAULT 'full_access',
  ADD COLUMN IF NOT EXISTS "restrictedDomainId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

-- ─── Extend SendMessage ───────────────────────────────────────────────────────
ALTER TABLE "send_messages"
  ADD COLUMN IF NOT EXISTS "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "templateId" TEXT,
  ADD COLUMN IF NOT EXISTS "tags" JSONB,
  ADD COLUMN IF NOT EXISTS "trackingToken" TEXT,
  ADD COLUMN IF NOT EXISTS "domainId" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "send_messages_trackingToken_key" ON "send_messages"("trackingToken");
CREATE UNIQUE INDEX IF NOT EXISTS "send_messages_idempotencyKey_key" ON "send_messages"("idempotencyKey");

-- ─── Extend BulkJobStatus enum ───────────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE "BulkJobStatus" ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Extend SuppressionReason enum ───────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE "SuppressionReason" ADD VALUE IF NOT EXISTS 'soft_bounce';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── SendingDomain ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sending_domains" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "region" TEXT NOT NULL DEFAULT 'us-east-1',
  "dkimSelector" TEXT NOT NULL,
  "dkimPublicKey" TEXT NOT NULL,
  "dkimPrivateKeyEnc" TEXT NOT NULL,
  "spfStatus" TEXT NOT NULL DEFAULT 'pending',
  "dkimStatus" TEXT NOT NULL DEFAULT 'pending',
  "returnPathStatus" TEXT NOT NULL DEFAULT 'pending',
  "trackOpens" BOOLEAN NOT NULL DEFAULT TRUE,
  "trackClicks" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sending_domains_apiKeyId_name_key" UNIQUE ("apiKeyId", "name"),
  CONSTRAINT "sending_domains_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sending_domains_apiKeyId_idx" ON "sending_domains"("apiKeyId");

-- ─── EmailTemplate ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_templates" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "variables" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_templates_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "email_templates_apiKeyId_idx" ON "email_templates"("apiKeyId");

-- ─── TrackingEvent ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tracking_events" (
  "id" TEXT NOT NULL,
  "sendMessageId" TEXT,
  "campaignId" TEXT,
  "sequenceId" TEXT,
  "email" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "linkUrl" TEXT,
  "userAgent" TEXT,
  "ip" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracking_events_sendMessageId_fkey" FOREIGN KEY ("sendMessageId") REFERENCES "send_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "tracking_events_sendMessageId_idx" ON "tracking_events"("sendMessageId");
CREATE INDEX IF NOT EXISTS "tracking_events_campaignId_idx" ON "tracking_events"("campaignId");
CREATE INDEX IF NOT EXISTS "tracking_events_sequenceId_idx" ON "tracking_events"("sequenceId");

-- ─── MailingList ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "mailing_lists" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "contactCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mailing_lists_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mailing_lists_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "mailing_lists_apiKeyId_idx" ON "mailing_lists"("apiKeyId");

-- ─── Contact ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "customFields" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contacts_apiKeyId_email_key" UNIQUE ("apiKeyId", "email"),
  CONSTRAINT "contacts_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "contacts_apiKeyId_idx" ON "contacts"("apiKeyId");

-- ─── ContactListMembership ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contact_list_memberships" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'subscribed',
  "gdprConsent" BOOLEAN NOT NULL DEFAULT FALSE,
  "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unsubscribedAt" TIMESTAMP(3),
  CONSTRAINT "contact_list_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contact_list_memberships_contactId_listId_key" UNIQUE ("contactId", "listId"),
  CONSTRAINT "contact_list_memberships_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "contact_list_memberships_listId_fkey" FOREIGN KEY ("listId") REFERENCES "mailing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "contact_list_memberships_listId_status_idx" ON "contact_list_memberships"("listId", "status");

-- ─── Segment ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "segments" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "listId" TEXT,
  "name" TEXT NOT NULL,
  "filterRules" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "segments_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "segments_apiKeyId_idx" ON "segments"("apiKeyId");

-- ─── Campaign ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaigns" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "fromName" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "domainId" TEXT,
  "replyTo" TEXT,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "trackOpens" BOOLEAN NOT NULL DEFAULT TRUE,
  "trackClicks" BOOLEAN NOT NULL DEFAULT TRUE,
  "scheduledAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "totalRecipients" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "openCount" INTEGER NOT NULL DEFAULT 0,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "bounceCount" INTEGER NOT NULL DEFAULT 0,
  "complaintCount" INTEGER NOT NULL DEFAULT 0,
  "sendDays" TEXT[] DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday']::TEXT[],
  "sendStartHour" INTEGER NOT NULL DEFAULT 8,
  "sendEndHour" INTEGER NOT NULL DEFAULT 17,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaigns_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "campaigns_apiKeyId_status_idx" ON "campaigns"("apiKeyId", "status");

-- Campaign ↔ MailingList join table
CREATE TABLE IF NOT EXISTS "_CampaignLists" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_CampaignLists_AB_pkey" PRIMARY KEY ("A", "B"),
  CONSTRAINT "_CampaignLists_A_fkey" FOREIGN KEY ("A") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "_CampaignLists_B_fkey" FOREIGN KEY ("B") REFERENCES "mailing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "_CampaignLists_B_index" ON "_CampaignLists"("B");

-- Campaign ↔ Segment join table
CREATE TABLE IF NOT EXISTS "_CampaignSegments" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_CampaignSegments_AB_pkey" PRIMARY KEY ("A", "B"),
  CONSTRAINT "_CampaignSegments_A_fkey" FOREIGN KEY ("A") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "_CampaignSegments_B_fkey" FOREIGN KEY ("B") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "_CampaignSegments_B_index" ON "_CampaignSegments"("B");

-- ─── CampaignRecipient ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaign_recipients" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "email" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "sesMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "openedAt" TIMESTAMP(3),
  "clickedAt" TIMESTAMP(3),
  CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "campaign_recipients_campaignId_status_idx" ON "campaign_recipients"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "campaign_recipients_sesMessageId_idx" ON "campaign_recipients"("sesMessageId");

-- ─── Mailbox ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "mailboxes" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "label" TEXT,
  "host" TEXT,
  "port" INTEGER,
  "username" TEXT NOT NULL,
  "passwordEnc" TEXT,
  "oauthTokenEnc" TEXT,
  "dailyLimit" INTEGER NOT NULL DEFAULT 200,
  "sendDelayMinMs" INTEGER NOT NULL DEFAULT 30000,
  "sendDelayMaxMs" INTEGER NOT NULL DEFAULT 120000,
  "sentToday" INTEGER NOT NULL DEFAULT 0,
  "sentTodayResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'active',
  "lastErrorMsg" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mailboxes_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "mailboxes_apiKeyId_status_idx" ON "mailboxes"("apiKeyId", "status");

-- ─── WarmupConfig ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "warmup_configs" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "targetPerDay" INTEGER NOT NULL DEFAULT 40,
  "currentPerDay" INTEGER NOT NULL DEFAULT 5,
  "rampUpDays" INTEGER NOT NULL DEFAULT 30,
  "poolTier" TEXT NOT NULL DEFAULT 'standard',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warmup_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warmup_configs_mailboxId_key" UNIQUE ("mailboxId"),
  CONSTRAINT "warmup_configs_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─── Sequence ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sequences" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "mailboxId" TEXT,
  "name" TEXT NOT NULL,
  "fromName" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "trackOpens" BOOLEAN NOT NULL DEFAULT TRUE,
  "trackClicks" BOOLEAN NOT NULL DEFAULT TRUE,
  "stopOnReply" BOOLEAN NOT NULL DEFAULT TRUE,
  "sendDays" TEXT[] DEFAULT ARRAY['monday','tuesday','wednesday','thursday','friday']::TEXT[],
  "sendStartHour" INTEGER NOT NULL DEFAULT 8,
  "sendEndHour" INTEGER NOT NULL DEFAULT 17,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sequences_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sequences_apiKeyId_idx" ON "sequences"("apiKeyId");

-- ─── SequenceStep ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sequence_steps" (
  "id" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "stepOrder" INTEGER NOT NULL,
  "delayDays" INTEGER NOT NULL DEFAULT 0,
  "delayHours" INTEGER NOT NULL DEFAULT 0,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "condition" TEXT NOT NULL DEFAULT 'always',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sequence_steps_sequenceId_stepOrder_key" UNIQUE ("sequenceId", "stepOrder"),
  CONSTRAINT "sequence_steps_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─── SequenceVariant ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sequence_variants" (
  "id" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "variantLabel" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "weight" INTEGER NOT NULL DEFAULT 50,
  CONSTRAINT "sequence_variants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sequence_variants_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "sequence_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sequence_variants_stepId_idx" ON "sequence_variants"("stepId");

-- ─── SequenceEnrollment ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sequence_enrollments" (
  "id" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "leadId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "currentStep" INTEGER NOT NULL DEFAULT 0,
  "nextSendAt" TIMESTAMP(3),
  "variables" JSONB,
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "repliedAt" TIMESTAMP(3),
  CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sequence_enrollments_sequenceId_email_key" UNIQUE ("sequenceId", "email"),
  CONSTRAINT "sequence_enrollments_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sequence_enrollments_sequenceId_status_nextSendAt_idx" ON "sequence_enrollments"("sequenceId", "status", "nextSendAt");

-- ─── Lead ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leads" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "company" TEXT,
  "title" TEXT,
  "customVars" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active',
  "repliedAt" TIMESTAMP(3),
  "unsubscribedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leads_apiKeyId_email_key" UNIQUE ("apiKeyId", "email"),
  CONSTRAINT "leads_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "leads_apiKeyId_status_idx" ON "leads"("apiKeyId", "status");

-- ─── ReplyEvent ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reply_events" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "inReplyToMessageId" TEXT,
  "enrollmentId" TEXT,
  "campaignRecipientId" TEXT,
  "subject" TEXT,
  "bodySnippet" TEXT,
  "isRead" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" TEXT NOT NULL DEFAULT 'new',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reply_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reply_events_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "reply_events_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "sequence_enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "reply_events_mailboxId_idx" ON "reply_events"("mailboxId");
CREATE INDEX IF NOT EXISTS "reply_events_enrollmentId_idx" ON "reply_events"("enrollmentId");

-- ─── InboxTest ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inbox_tests" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "domainId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "results" JSONB,
  "score" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedAt" TIMESTAMP(3),
  CONSTRAINT "inbox_tests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_tests_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "inbox_tests_apiKeyId_idx" ON "inbox_tests"("apiKeyId");

-- ─── SequenceTemplate ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "sequence_templates" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL DEFAULT 'cold_outreach',
  "steps" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sequence_templates_pkey" PRIMARY KEY ("id")
);

-- Seed a few built-in sequence templates
INSERT INTO "sequence_templates" ("id", "name", "description", "category", "steps")
VALUES
  ('tmpl_cold_intro', 'Cold Intro', 'Classic 3-touch cold outreach sequence', 'cold_outreach', '[{"stepOrder":1,"delayDays":0,"subject":"Quick question about {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>I came across {{company}} and was impressed by your work in {{industry}}.</p><p>I wanted to reach out because {{value_prop}}.</p><p>Would you be open to a 15-minute call this week?</p>","condition":"always"},{"stepOrder":2,"delayDays":3,"subject":"Re: Quick question about {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>Just wanted to follow up on my previous email.</p><p>{{personalized_line}}</p><p>Would love to connect — does Thursday or Friday work for a quick call?</p>","condition":"if_not_replied"},{"stepOrder":3,"delayDays":7,"subject":"Last touch — {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>I understand you may be busy. I''ll keep this short — if {{company}} is interested in {{value_prop}}, I''d love to chat.</p><p>If not, no worries at all. Just let me know.</p>","condition":"if_not_replied"}]'),
  ('tmpl_followup', 'Follow-Up Sequence', '2-step follow-up for warm leads', 'follow_up', '[{"stepOrder":1,"delayDays":2,"subject":"Following up — {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>Wanted to follow up on our conversation about {{topic}}.</p><p>Have you had a chance to review?</p>","condition":"always"},{"stepOrder":2,"delayDays":5,"subject":"One last follow-up","htmlBody":"<p>Hi {{first_name}},</p><p>I''ll keep this brief — still interested in connecting about {{topic}}?</p><p>If not, I''ll close out this thread.</p>","condition":"if_not_replied"}]'),
  ('tmpl_reengagement', 'Re-Engagement', 'Win back cold/gone-dark prospects', 're_engagement', '[{"stepOrder":1,"delayDays":0,"subject":"Still relevant?","htmlBody":"<p>Hi {{first_name}},</p><p>It''s been a while since we last connected.</p><p>Things have changed on our end — {{new_value_prop}}.</p><p>Worth a quick catch-up?</p>","condition":"always"}]')
ON CONFLICT DO NOTHING;

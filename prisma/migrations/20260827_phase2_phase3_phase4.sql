-- Phase 2/3/4 migrations: new enums, new models, new fields
-- Run: npx prisma db execute --file prisma/migrations/20260827_phase2_phase3_phase4.sql --schema prisma/schema.prisma

-- 1. Extend SendStatus enum
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'opened';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'clicked';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- 2. Extend SuppressionReason enum
ALTER TYPE "SuppressionReason" ADD VALUE IF NOT EXISTS 'unsubscribed';

-- 3. Extend ApiKey table
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "permission" TEXT NOT NULL DEFAULT 'full_access';
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "restrictedDomainId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

-- 4. Extend SendMessage table
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "cc" TEXT[] DEFAULT '{}';
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "bcc" TEXT[] DEFAULT '{}';
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "tags" JSONB;
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "trackingToken" TEXT;
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "domainId" TEXT;
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "SendMessage" ADD COLUMN IF NOT EXISTS "replyTo" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "SendMessage_trackingToken_key" ON "SendMessage"("trackingToken");
CREATE UNIQUE INDEX IF NOT EXISTS "SendMessage_idempotencyKey_key" ON "SendMessage"("idempotencyKey");

-- 5. SendingDomain table
CREATE TABLE IF NOT EXISTS "SendingDomain" (
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
  "trackOpens" BOOLEAN NOT NULL DEFAULT true,
  "trackClicks" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SendingDomain_apiKeyId_name_key" ON "SendingDomain"("apiKeyId", "name");
CREATE INDEX IF NOT EXISTS "SendingDomain_apiKeyId_idx" ON "SendingDomain"("apiKeyId");

-- 6. EmailTemplate table
CREATE TABLE IF NOT EXISTS "EmailTemplate" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "variables" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EmailTemplate_apiKeyId_idx" ON "EmailTemplate"("apiKeyId");

-- 7. TrackingEvent table
CREATE TABLE IF NOT EXISTS "TrackingEvent" (
  "id" TEXT NOT NULL,
  "sendMessageId" TEXT,
  "campaignId" TEXT,
  "email" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "linkUrl" TEXT,
  "userAgent" TEXT,
  "ip" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TrackingEvent_sendMessageId_idx" ON "TrackingEvent"("sendMessageId");
CREATE INDEX IF NOT EXISTS "TrackingEvent_campaignId_idx" ON "TrackingEvent"("campaignId");

-- 8. MailingList table
CREATE TABLE IF NOT EXISTS "MailingList" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "contactCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MailingList_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MailingList_apiKeyId_idx" ON "MailingList"("apiKeyId");

-- 9. Contact table
CREATE TABLE IF NOT EXISTS "Contact" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "customFields" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_apiKeyId_email_key" ON "Contact"("apiKeyId", "email");
CREATE INDEX IF NOT EXISTS "Contact_apiKeyId_idx" ON "Contact"("apiKeyId");

-- 10. ContactListMembership table
CREATE TABLE IF NOT EXISTS "ContactListMembership" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "listId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'subscribed',
  "gdprConsent" BOOLEAN NOT NULL DEFAULT false,
  "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unsubscribedAt" TIMESTAMP(3),
  CONSTRAINT "ContactListMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContactListMembership_contactId_listId_key" ON "ContactListMembership"("contactId", "listId");
CREATE INDEX IF NOT EXISTS "ContactListMembership_listId_status_idx" ON "ContactListMembership"("listId", "status");

-- 11. Segment table
CREATE TABLE IF NOT EXISTS "Segment" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "listId" TEXT,
  "name" TEXT NOT NULL,
  "filterRules" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Segment_apiKeyId_idx" ON "Segment"("apiKeyId");

-- 12. Campaign table
CREATE TABLE IF NOT EXISTS "Campaign" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "fromName" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "domainId" TEXT,
  "replyTo" TEXT,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "listIds" TEXT[] DEFAULT '{}',
  "segmentIds" TEXT[] DEFAULT '{}',
  "excludeListIds" TEXT[] DEFAULT '{}',
  "trackOpens" BOOLEAN NOT NULL DEFAULT true,
  "trackClicks" BOOLEAN NOT NULL DEFAULT true,
  "scheduledAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "totalRecipients" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredCount" INTEGER NOT NULL DEFAULT 0,
  "openCount" INTEGER NOT NULL DEFAULT 0,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "bounceCount" INTEGER NOT NULL DEFAULT 0,
  "complaintCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Campaign_apiKeyId_status_idx" ON "Campaign"("apiKeyId", "status");

-- 13. CampaignRecipient table
CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
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
  CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_email_idx" ON "CampaignRecipient"("email");

-- 14. Mailbox table
CREATE TABLE IF NOT EXISTS "Mailbox" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
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
  CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Mailbox_apiKeyId_status_idx" ON "Mailbox"("apiKeyId", "status");

-- 15. WarmupConfig table
CREATE TABLE IF NOT EXISTS "WarmupConfig" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "targetPerDay" INTEGER NOT NULL DEFAULT 40,
  "currentPerDay" INTEGER NOT NULL DEFAULT 5,
  "rampUpDays" INTEGER NOT NULL DEFAULT 30,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WarmupConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WarmupConfig_mailboxId_key" ON "WarmupConfig"("mailboxId");

-- 16. Sequence table
CREATE TABLE IF NOT EXISTS "Sequence" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "mailboxId" TEXT,
  "name" TEXT NOT NULL,
  "fromName" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "trackOpens" BOOLEAN NOT NULL DEFAULT true,
  "trackClicks" BOOLEAN NOT NULL DEFAULT true,
  "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
  "sendDays" TEXT[] DEFAULT '{"monday","tuesday","wednesday","thursday","friday"}',
  "sendStartHour" INTEGER NOT NULL DEFAULT 8,
  "sendEndHour" INTEGER NOT NULL DEFAULT 17,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Sequence_apiKeyId_idx" ON "Sequence"("apiKeyId");

-- 17. SequenceStep table
CREATE TABLE IF NOT EXISTS "SequenceStep" (
  "id" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "stepOrder" INTEGER NOT NULL,
  "delayDays" INTEGER NOT NULL DEFAULT 0,
  "delayHours" INTEGER NOT NULL DEFAULT 0,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT,
  "condition" TEXT NOT NULL DEFAULT 'always',
  CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SequenceStep_sequenceId_stepOrder_key" ON "SequenceStep"("sequenceId", "stepOrder");

-- 18. SequenceEnrollment table
CREATE TABLE IF NOT EXISTS "SequenceEnrollment" (
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
  CONSTRAINT "SequenceEnrollment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SequenceEnrollment_sequenceId_email_key" ON "SequenceEnrollment"("sequenceId", "email");
CREATE INDEX IF NOT EXISTS "SequenceEnrollment_sequenceId_status_nextSendAt_idx" ON "SequenceEnrollment"("sequenceId", "status", "nextSendAt");

-- 19. Lead table
CREATE TABLE IF NOT EXISTS "Lead" (
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
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_apiKeyId_email_key" ON "Lead"("apiKeyId", "email");
CREATE INDEX IF NOT EXISTS "Lead_apiKeyId_status_idx" ON "Lead"("apiKeyId", "status");

-- 20. ReplyEvent table
CREATE TABLE IF NOT EXISTS "ReplyEvent" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "inReplyToMessageId" TEXT,
  "enrollmentId" TEXT,
  "subject" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplyEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReplyEvent_mailboxId_idx" ON "ReplyEvent"("mailboxId");
CREATE INDEX IF NOT EXISTS "ReplyEvent_enrollmentId_idx" ON "ReplyEvent"("enrollmentId");

-- 21. InboxTest table
CREATE TABLE IF NOT EXISTS "InboxTest" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "results" JSONB,
  "score" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedAt" TIMESTAMP(3),
  CONSTRAINT "InboxTest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "InboxTest_apiKeyId_idx" ON "InboxTest"("apiKeyId");

-- 22. SequenceTemplate table (curated library, seeded)
CREATE TABLE IF NOT EXISTS "SequenceTemplate" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT NOT NULL DEFAULT 'outreach',
  "stepsJson" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SequenceTemplate_pkey" PRIMARY KEY ("id")
);

-- Seed a few starter sequence templates
INSERT INTO "SequenceTemplate" ("id", "name", "description", "category", "stepsJson")
VALUES
  ('tpl_cold_intro', 'Cold Introduction', 'Classic 3-step cold outreach intro', 'outreach', '[{"stepOrder":1,"delayDays":0,"subject":"Quick question about {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>I came across {{company}} and wanted to reach out. We help teams like yours {{value_prop}}.</p><p>Would you be open to a quick 15-min call this week?</p>","condition":"always"},{"stepOrder":2,"delayDays":3,"subject":"Re: Quick question about {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>Just following up on my last email — wanted to make sure it didn''t get buried.</p><p>Happy to keep it brief: would a quick call work for you?</p>","condition":"if_not_replied"},{"stepOrder":3,"delayDays":7,"subject":"Last note — {{company}}","htmlBody":"<p>Hi {{first_name}},</p><p>I''ll keep this short — if now isn''t the right time, totally understand. Feel free to reply whenever it makes sense.</p>","condition":"if_not_replied"}]'),
  ('tpl_saas_trial', 'SaaS Trial Follow-up', 'Nurture trial users to convert', 'nurture', '[{"stepOrder":1,"delayDays":1,"subject":"Getting started with {{product_name}}?","htmlBody":"<p>Hi {{first_name}},</p><p>Welcome! Here are the 3 things most users do first to get value fast...</p>","condition":"always"},{"stepOrder":2,"delayDays":3,"subject":"How''s {{product_name}} going?","htmlBody":"<p>Hi {{first_name}},</p><p>Checking in — have you had a chance to explore {{product_name}}? Happy to jump on a quick call if you have questions.</p>","condition":"if_not_replied"},{"stepOrder":3,"delayDays":7,"subject":"Your trial ends soon","htmlBody":"<p>Hi {{first_name}},</p><p>Your trial is almost up. Want to keep going? Here''s how to upgrade...</p>","condition":"always"}]')
ON CONFLICT ("id") DO NOTHING;

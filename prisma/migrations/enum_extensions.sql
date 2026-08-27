ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'opened';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'clicked';
ALTER TYPE "SendStatus" ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE "SuppressionReason" ADD VALUE IF NOT EXISTS 'unsubscribed';

-- Bot/prefetch classification for tracking events — see the comment above
-- TrackingEvent.isLikelyBot in schema.prisma for why this exists.
ALTER TABLE "tracking_events"
  ADD COLUMN IF NOT EXISTS "isLikelyBot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "botReason" TEXT;

CREATE INDEX IF NOT EXISTS "tracking_events_isLikelyBot_idx" ON "tracking_events"("isLikelyBot");

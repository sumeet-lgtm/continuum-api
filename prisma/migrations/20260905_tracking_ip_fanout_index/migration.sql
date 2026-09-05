-- Backs checkIpFanout in engine/botDetection.ts — see the comment above
-- the index in schema.prisma for why.
CREATE INDEX IF NOT EXISTS "tracking_events_ip_occurredAt_idx" ON "tracking_events"("ip", "occurredAt");

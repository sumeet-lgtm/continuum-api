-- House-owned seed mailboxes for the warmup pool — see Mailbox.isHousePool
-- comment in schema.prisma for why this exists (the shared cross-customer
-- pool never reached its 2-participant minimum with real customer mailboxes
-- alone).
ALTER TABLE "mailboxes"
  ADD COLUMN IF NOT EXISTS "isHousePool" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "mailboxes_isHousePool_status_idx" ON "mailboxes"("isHousePool", "status");

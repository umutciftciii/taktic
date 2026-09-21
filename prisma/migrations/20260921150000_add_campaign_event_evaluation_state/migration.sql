-- CMP-002 S2B2 rev. 2 (Migration E): durable evaluation state on campaign events.
--
-- Purely additive: one new enum, eight nullable-or-defaulted columns on
-- "CampaignTriggerEvent", one index and one CHECK. No existing column changes
-- type or default, nothing is dropped, and no row is read, written, converted
-- or seeded — the table is empty in every real environment (the engine has
-- never been on), and a row that did exist would read PENDING/0/now with no
-- lease and no error, which is exactly "raised, not yet evaluated".
--
-- The CHECK ties the new status to the existing settlement columns: an event
-- is SETTLED exactly when a redemption settled it. The engine writes both in
-- one statement (settleEvent), so no intermediate row can violate it.

CREATE TYPE "CampaignTriggerEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'EVALUATED', 'SETTLED', 'RETRY_WAIT');

ALTER TABLE "CampaignTriggerEvent"
  ADD COLUMN "status" "CampaignTriggerEventStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

CREATE INDEX "CampaignTriggerEvent_status_nextAttemptAt_idx" ON "CampaignTriggerEvent"("status", "nextAttemptAt");

ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_attemptCount_nonnegative"
  CHECK ("attemptCount" >= 0);
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_settled_status_matches"
  CHECK (("status" = 'SETTLED') = ("settledRedemptionId" IS NOT NULL));

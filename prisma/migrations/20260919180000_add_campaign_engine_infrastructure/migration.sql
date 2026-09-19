-- CMP-002 S2A (Migration B): campaign engine infrastructure.
--
-- Purely additive. Six new tables, four new enums, three nullable columns and
-- two zero-default counters on Campaign; no existing column changes type, no
-- row is read, written, converted or seeded, and the credit ledger is not
-- touched — "CreditTransactionType" keeps its six values and the three
-- "*TransactionId" columns below are nullable references that stay NULL until
-- S2B adds the CAMPAIGN_* types.
--
-- Nothing in the application calls the engine that writes these tables in
-- this slice, and the engine's switch (OperationsSettings.campaignEngineEnabled)
-- is false by default with no endpoint that sets it. The CHECKs at the end
-- bound what the tables may say so that a row the engine would never write
-- cannot be written by anything else either (CMP-001 §3.2, §12.2).

-- CreateEnum
CREATE TYPE "CampaignRedemptionStatus" AS ENUM ('GRANTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CampaignRevokeReason" AS ENUM ('PAYMENT_REVERSED', 'ADMIN_REVOKED');

-- CreateEnum
CREATE TYPE "PromoCreditLotStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CampaignEvaluationOutcome" AS ENUM ('GRANTED', 'NO_CANDIDATE', 'CONDITIONS_FAILED', 'WINDOW_CLOSED', 'ELIGIBILITY_INCOMPLETE', 'STACK_CONFLICT', 'EVENT_ALREADY_SETTLED', 'ALREADY_REDEEMED', 'CAMPAIGN_PAUSED', 'PER_PROVIDER_LIMIT', 'GLOBAL_LIMIT', 'DAILY_LIMIT', 'BUDGET_EXHAUSTED', 'ENGINE_DISABLED', 'ENGINE_ERROR');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "activeVersionId" TEXT,
ADD COLUMN     "budgetConsumedCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "redemptionCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CampaignTriggerEvent" (
    "id" TEXT NOT NULL,
    "triggerEventKey" TEXT NOT NULL,
    "trigger" "CampaignTrigger" NOT NULL,
    "providerId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "factSetKey" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluationCount" INTEGER NOT NULL DEFAULT 0,
    "settledByCampaignId" TEXT,
    "settledRedemptionId" TEXT,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "CampaignTriggerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRedemption" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignVersionId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT,
    "trigger" "CampaignTrigger" NOT NULL,
    "triggerEventId" TEXT NOT NULL,
    "triggerEventKey" TEXT NOT NULL,
    "purchaseId" TEXT,
    "status" "CampaignRedemptionStatus" NOT NULL DEFAULT 'GRANTED',
    "rulesSnapshot" JSONB NOT NULL,
    "grantedCredits" INTEGER NOT NULL,
    "grantTransactionId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" "CampaignRevokeReason",
    "spentAtRevoke" INTEGER,
    "revokedById" TEXT,

    CONSTRAINT "CampaignRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvaluationLog" (
    "id" TEXT NOT NULL,
    "triggerEventId" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignVersionId" TEXT,
    "providerId" TEXT NOT NULL,
    "fact" "CampaignEligibilityFact",
    "outcome" "CampaignEvaluationOutcome" NOT NULL,
    "reasonCode" TEXT,
    "winnerCampaignId" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvaluationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCreditLot" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "redemptionId" TEXT NOT NULL,
    "grantedCredits" INTEGER NOT NULL,
    "remainingCredits" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "PromoCreditLotStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiryTransactionId" TEXT,
    "revokeTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCreditLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignProviderCounter" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignProviderCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDailyCounter" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDailyCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTriggerEvent_triggerEventKey_key" ON "CampaignTriggerEvent"("triggerEventKey");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTriggerEvent_settledRedemptionId_key" ON "CampaignTriggerEvent"("settledRedemptionId");

-- CreateIndex
CREATE INDEX "CampaignTriggerEvent_providerId_firstSeenAt_idx" ON "CampaignTriggerEvent"("providerId", "firstSeenAt");

-- CreateIndex
CREATE INDEX "CampaignTriggerEvent_purchaseId_idx" ON "CampaignTriggerEvent"("purchaseId");

-- CreateIndex
CREATE INDEX "CampaignTriggerEvent_settledByCampaignId_idx" ON "CampaignTriggerEvent"("settledByCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRedemption_grantTransactionId_key" ON "CampaignRedemption"("grantTransactionId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_triggerEventKey_idx" ON "CampaignRedemption"("triggerEventKey");

-- CreateIndex
CREATE INDEX "CampaignRedemption_triggerEventId_idx" ON "CampaignRedemption"("triggerEventId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_campaignId_providerId_idx" ON "CampaignRedemption"("campaignId", "providerId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_providerId_status_idx" ON "CampaignRedemption"("providerId", "status");

-- CreateIndex
CREATE INDEX "CampaignRedemption_campaignVersionId_idx" ON "CampaignRedemption"("campaignVersionId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_purchaseId_idx" ON "CampaignRedemption"("purchaseId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_userId_idx" ON "CampaignRedemption"("userId");

-- CreateIndex
CREATE INDEX "CampaignRedemption_revokedById_idx" ON "CampaignRedemption"("revokedById");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRedemption_campaignId_triggerEventKey_key" ON "CampaignRedemption"("campaignId", "triggerEventKey");

-- CreateIndex
CREATE INDEX "CampaignEvaluationLog_triggerEventId_evaluatedAt_idx" ON "CampaignEvaluationLog"("triggerEventId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "CampaignEvaluationLog_campaignId_evaluatedAt_idx" ON "CampaignEvaluationLog"("campaignId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "CampaignEvaluationLog_providerId_evaluatedAt_idx" ON "CampaignEvaluationLog"("providerId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "CampaignEvaluationLog_campaignVersionId_idx" ON "CampaignEvaluationLog"("campaignVersionId");

-- CreateIndex
CREATE INDEX "CampaignEvaluationLog_winnerCampaignId_idx" ON "CampaignEvaluationLog"("winnerCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCreditLot_redemptionId_key" ON "PromoCreditLot"("redemptionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCreditLot_expiryTransactionId_key" ON "PromoCreditLot"("expiryTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCreditLot_revokeTransactionId_key" ON "PromoCreditLot"("revokeTransactionId");

-- CreateIndex
CREATE INDEX "PromoCreditLot_providerId_status_expiresAt_idx" ON "PromoCreditLot"("providerId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "PromoCreditLot_status_expiresAt_idx" ON "PromoCreditLot"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CampaignProviderCounter_providerId_idx" ON "CampaignProviderCounter"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignProviderCounter_campaignId_providerId_key" ON "CampaignProviderCounter"("campaignId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDailyCounter_campaignId_day_key" ON "CampaignDailyCounter"("campaignId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_activeVersionId_key" ON "Campaign"("activeVersionId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "CampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_settledByCampaignId_fkey" FOREIGN KEY ("settledByCampaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_settledRedemptionId_fkey" FOREIGN KEY ("settledRedemptionId") REFERENCES "CampaignRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_campaignVersionId_fkey" FOREIGN KEY ("campaignVersionId") REFERENCES "CampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "CampaignTriggerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_grantTransactionId_fkey" FOREIGN KEY ("grantTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvaluationLog" ADD CONSTRAINT "CampaignEvaluationLog_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "CampaignTriggerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvaluationLog" ADD CONSTRAINT "CampaignEvaluationLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvaluationLog" ADD CONSTRAINT "CampaignEvaluationLog_campaignVersionId_fkey" FOREIGN KEY ("campaignVersionId") REFERENCES "CampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvaluationLog" ADD CONSTRAINT "CampaignEvaluationLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvaluationLog" ADD CONSTRAINT "CampaignEvaluationLog_winnerCampaignId_fkey" FOREIGN KEY ("winnerCampaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "CampaignRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_expiryTransactionId_fkey" FOREIGN KEY ("expiryTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_revokeTransactionId_fkey" FOREIGN KEY ("revokeTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignProviderCounter" ADD CONSTRAINT "CampaignProviderCounter_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignProviderCounter" ADD CONSTRAINT "CampaignProviderCounter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDailyCounter" ADD CONSTRAINT "CampaignDailyCounter_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Integrity the database can state on its own (S2A design note §2).

-- Campaign: cumulative counters never go negative.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_counters_nonnegative"
  CHECK ("redemptionCount" >= 0 AND "budgetConsumedCredits" >= 0);

-- CampaignTriggerEvent: an event is settled by all three columns or by none;
-- the key's shape follows its trigger.
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_evaluationCount_nonnegative"
  CHECK ("evaluationCount" >= 0);
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_settlement_complete"
  CHECK (("settledByCampaignId" IS NULL) = ("settledRedemptionId" IS NULL)
     AND ("settledRedemptionId" IS NULL) = ("settledAt" IS NULL));
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_factSetKey_matches_trigger"
  CHECK (("trigger" = 'PROVIDER_ELIGIBILITY_REACHED') = ("factSetKey" IS NOT NULL));
ALTER TABLE "CampaignTriggerEvent" ADD CONSTRAINT "CampaignTriggerEvent_purchase_matches_trigger"
  CHECK (("trigger" = 'PACKAGE_PAYMENT_SUCCEEDED') = ("purchaseId" IS NOT NULL));

-- CampaignRedemption: the granted amount is a valid benefit; a revocation is
-- complete or absent; what was spent at revocation fits the grant.
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_grantedCredits_bounded"
  CHECK ("grantedCredits" BETWEEN 1 AND 1000);
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_revocation_complete"
  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
     AND ("status" = 'REVOKED') = ("revokeReason" IS NOT NULL));
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_spentAtRevoke_bounded"
  CHECK ("spentAtRevoke" IS NULL OR "spentAtRevoke" BETWEEN 0 AND "grantedCredits");

-- PromoCreditLot: credits are never negative, the remainder never exceeds the
-- grant, and EXHAUSTED means empty.
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_credits_bounded"
  CHECK ("grantedCredits" >= 1 AND "remainingCredits" >= 0 AND "remainingCredits" <= "grantedCredits");
ALTER TABLE "PromoCreditLot" ADD CONSTRAINT "PromoCreditLot_exhausted_means_empty"
  CHECK ("status" <> 'EXHAUSTED' OR "remainingCredits" = 0);

-- Counters: never negative.
ALTER TABLE "CampaignProviderCounter" ADD CONSTRAINT "CampaignProviderCounter_redemptionCount_nonnegative"
  CHECK ("redemptionCount" >= 0);
ALTER TABLE "CampaignDailyCounter" ADD CONSTRAINT "CampaignDailyCounter_redemptionCount_nonnegative"
  CHECK ("redemptionCount" >= 0);

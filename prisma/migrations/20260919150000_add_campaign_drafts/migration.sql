-- CMP-002 S0/S1 (Migration A): campaign definitions and immutable drafts.
--
-- Purely additive. Three new tables, six new enums and one boolean on
-- OperationsSettings; no existing column, constraint or row is touched, and
-- nothing here reads or writes the credit ledger, purchases or entitlements.
-- No row is seeded: a fresh database has no campaign, and the engine switch
-- reads as "off" whether or not the settings row exists.
--
-- CampaignVersion is written once and never updated by the application; the
-- CHECKs below bound what a row may say so that a definition the validator
-- would refuse cannot be stored by anything else either (CMP-001 §3.2).

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "CampaignTrigger" AS ENUM ('PROVIDER_APPROVED', 'PACKAGE_PAYMENT_SUCCEEDED', 'PROVIDER_ELIGIBILITY_REACHED');

-- CreateEnum
CREATE TYPE "CampaignEligibilityFact" AS ENUM ('PROVIDER_APPROVED', 'EMAIL_VERIFIED', 'PHONE_VERIFIED');

-- CreateEnum
CREATE TYPE "CampaignBenefitType" AS ENUM ('PROMO_CREDITS');

-- CreateEnum
CREATE TYPE "CampaignStackPolicy" AS ENUM ('EXCLUSIVE_CREDIT_BONUS');

-- CreateEnum
CREATE TYPE "CampaignAuditAction" AS ENUM ('CREATED', 'VERSION_CREATED');

-- AlterTable
ALTER TABLE "OperationsSettings" ADD COLUMN     "campaignEngineEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignVersion" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "trigger" "CampaignTrigger" NOT NULL,
    "eligibilityFacts" "CampaignEligibilityFact"[],
    "factSetKey" TEXT,
    "definition" JSONB NOT NULL,
    "benefitType" "CampaignBenefitType" NOT NULL,
    "benefitCredits" INTEGER NOT NULL,
    "benefitExpiresInDays" INTEGER NOT NULL,
    "maxRedemptionsPerProvider" INTEGER NOT NULL,
    "maxRedemptionsGlobal" INTEGER,
    "maxRedemptionsPerDay" INTEGER,
    "budgetCredits" INTEGER,
    "windowStartAt" TIMESTAMP(3),
    "windowEndAt" TIMESTAMP(3),
    "stackPolicy" "CampaignStackPolicy" NOT NULL,
    "priority" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAuditLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" "CampaignAuditAction" NOT NULL,
    "campaignVersionId" TEXT,
    "actorId" TEXT NOT NULL,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_key_key" ON "Campaign"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_currentVersionId_key" ON "Campaign"("currentVersionId");

-- CreateIndex
CREATE INDEX "Campaign_status_updatedAt_idx" ON "Campaign"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Campaign_createdById_idx" ON "Campaign"("createdById");

-- CreateIndex
CREATE INDEX "CampaignVersion_trigger_factSetKey_idx" ON "CampaignVersion"("trigger", "factSetKey");

-- CreateIndex
CREATE INDEX "CampaignVersion_createdById_idx" ON "CampaignVersion"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignVersion_campaignId_versionNumber_key" ON "CampaignVersion"("campaignId", "versionNumber");

-- CreateIndex
CREATE INDEX "CampaignAuditLog_campaignId_createdAt_idx" ON "CampaignAuditLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignAuditLog_actorId_idx" ON "CampaignAuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "CampaignVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAuditLog" ADD CONSTRAINT "CampaignAuditLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAuditLog" ADD CONSTRAINT "CampaignAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Bounds, mirroring packages/shared/campaign-rules.json. The validator is the
-- authority on the full rule language; these are the parts a database can
-- state on its own.
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_versionNumber_positive"
  CHECK ("versionNumber" >= 1);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_benefitCredits_bounded"
  CHECK ("benefitCredits" BETWEEN 1 AND 1000);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_benefitExpiresInDays_bounded"
  CHECK ("benefitExpiresInDays" BETWEEN 1 AND 365);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_maxRedemptionsPerProvider_bounded"
  CHECK ("maxRedemptionsPerProvider" BETWEEN 1 AND 100);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_maxRedemptionsGlobal_bounded"
  CHECK ("maxRedemptionsGlobal" IS NULL OR "maxRedemptionsGlobal" BETWEEN 1 AND 1000000);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_maxRedemptionsPerDay_bounded"
  CHECK ("maxRedemptionsPerDay" IS NULL OR "maxRedemptionsPerDay" BETWEEN 1 AND 100000);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_budgetCredits_bounded"
  CHECK ("budgetCredits" IS NULL OR "budgetCredits" BETWEEN 1 AND 10000000);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_priority_bounded"
  CHECK ("priority" BETWEEN 1 AND 1000);
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_factSetKey_matches_trigger"
  CHECK (("trigger" = 'PROVIDER_ELIGIBILITY_REACHED') = ("factSetKey" IS NOT NULL));
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_window_ordered"
  CHECK ("windowStartAt" IS NULL OR "windowEndAt" IS NULL OR "windowStartAt" < "windowEndAt");

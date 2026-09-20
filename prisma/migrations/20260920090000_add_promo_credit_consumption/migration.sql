-- CMP-002 S2B1 (Migration C): promo credit accounting.
--
-- Purely additive. Three values appended to "CreditTransactionType" (the six
-- existing values keep their position and meaning), one new enum and one new
-- table with its indexes, foreign keys and CHECKs. No existing column changes
-- type, no row is read, written, converted or seeded: every OFFER_SPEND and
-- OFFER_REFUND row that exists today was paid from the paid balance and gets
-- no consumption row. "CampaignRedemption"."grantTransactionId" already is
-- the nullable, unique, RESTRICT foreign key to the ledger (Migration B) and
-- is not touched.
--
-- ADD VALUE inside the migration's transaction is fine on PostgreSQL 12+ as
-- long as the same transaction does not use the new value, and nothing below
-- does (the add_request_matching migration set the same precedent).
--
-- Nothing in the application writes the new types or the new table in this
-- slice except the offer spend / refund paths — and only when a provider
-- holds a PromoCreditLot, which no production code path can create while the
-- campaign engine is off and unhooked.

-- CreateEnum
CREATE TYPE "PromoCreditLotConsumptionStatus" AS ENUM ('CONSUMED', 'REFUNDED', 'FORFEITED');

-- AlterEnum
ALTER TYPE "CreditTransactionType" ADD VALUE 'CAMPAIGN_GRANT';
ALTER TYPE "CreditTransactionType" ADD VALUE 'CAMPAIGN_EXPIRE';
ALTER TYPE "CreditTransactionType" ADD VALUE 'CAMPAIGN_REVOKE';

-- CreateTable
CREATE TABLE "PromoCreditLotConsumption" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "creditTransactionId" TEXT NOT NULL,
    "consumedCredits" INTEGER NOT NULL,
    "refundedCredits" INTEGER NOT NULL DEFAULT 0,
    "forfeitedCredits" INTEGER NOT NULL DEFAULT 0,
    "status" "PromoCreditLotConsumptionStatus" NOT NULL DEFAULT 'CONSUMED',
    "refundTransactionId" TEXT,
    "forfeitTransactionId" TEXT,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PromoCreditLotConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCreditLotConsumption_forfeitTransactionId_key" ON "PromoCreditLotConsumption"("forfeitTransactionId");

-- CreateIndex
CREATE INDEX "PromoCreditLotConsumption_creditTransactionId_idx" ON "PromoCreditLotConsumption"("creditTransactionId");

-- CreateIndex
CREATE INDEX "PromoCreditLotConsumption_lotId_idx" ON "PromoCreditLotConsumption"("lotId");

-- CreateIndex
CREATE INDEX "PromoCreditLotConsumption_refundTransactionId_idx" ON "PromoCreditLotConsumption"("refundTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCreditLotConsumption_lotId_creditTransactionId_key" ON "PromoCreditLotConsumption"("lotId", "creditTransactionId");

-- AddForeignKey
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "PromoCreditLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_refundTransactionId_fkey" FOREIGN KEY ("refundTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_forfeitTransactionId_fkey" FOREIGN KEY ("forfeitTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Integrity the database can state on its own (S2B1 design note §4).

-- A share is at least one credit; what came back and what was forfeited are
-- never negative and never exceed the share.
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_credits_bounded"
  CHECK ("consumedCredits" >= 1 AND "refundedCredits" >= 0 AND "forfeitedCredits" >= 0
     AND "refundedCredits" + "forfeitedCredits" <= "consumedCredits");

-- CONSUMED means unsettled: no refund row, no settlement time, nothing moved
-- back or out. Anything else names the refund that settled it.
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_settlement_complete"
  CHECK (("status" = 'CONSUMED') = ("settledAt" IS NULL)
     AND ("status" = 'CONSUMED') = ("refundTransactionId" IS NULL));
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_consumed_untouched"
  CHECK ("status" <> 'CONSUMED' OR ("refundedCredits" = 0 AND "forfeitedCredits" = 0));

-- REFUNDED and FORFEITED each account for the whole share, one way only, and a
-- forfeit always names the negative ledger row that carried it out.
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_refunded_whole"
  CHECK ("status" <> 'REFUNDED' OR ("refundedCredits" = "consumedCredits" AND "forfeitedCredits" = 0));
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_forfeited_whole"
  CHECK ("status" <> 'FORFEITED' OR ("forfeitedCredits" = "consumedCredits" AND "refundedCredits" = 0));
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_forfeit_row_matches_status"
  CHECK (("status" = 'FORFEITED') = ("forfeitTransactionId" IS NOT NULL));

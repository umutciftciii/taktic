-- Add global human-readable numbering for ServiceRequest, Offer, and PackagePurchase.
-- All number columns are nullable + unique so existing rows are preserved untouched.
-- A SequenceCounter table tracks per-entity / per-year counters used by the
-- generation helper and the backfill script. NOT NULL constraints are deferred
-- to a follow-up migration once create flows always populate the number.

-- CreateEnum
CREATE TYPE "NumberedEntityType" AS ENUM ('SERVICE_REQUEST', 'OFFER', 'PACKAGE_PURCHASE');

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "offerNumber" TEXT;

-- AlterTable
ALTER TABLE "PackagePurchase" ADD COLUMN     "purchaseNumber" TEXT;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "requestNumber" TEXT;

-- CreateTable
CREATE TABLE "SequenceCounter" (
    "id" TEXT NOT NULL,
    "entityType" "NumberedEntityType" NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequenceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SequenceCounter_entityType_idx" ON "SequenceCounter"("entityType");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceCounter_entityType_year_key" ON "SequenceCounter"("entityType", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_offerNumber_key" ON "Offer"("offerNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchase_purchaseNumber_key" ON "PackagePurchase"("purchaseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_requestNumber_key" ON "ServiceRequest"("requestNumber");

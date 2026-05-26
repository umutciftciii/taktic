-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "creditCost" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "creditRefundReason" TEXT,
ADD COLUMN     "creditRefundedAt" TIMESTAMP(3),
ADD COLUMN     "creditRefundedTransactionId" TEXT,
ADD COLUMN     "creditSpentTransactionId" TEXT;

-- CreateIndex
CREATE INDEX "Offer_creditSpentTransactionId_idx" ON "Offer"("creditSpentTransactionId");

-- CreateIndex
CREATE INDEX "Offer_creditRefundedTransactionId_idx" ON "Offer"("creditRefundedTransactionId");

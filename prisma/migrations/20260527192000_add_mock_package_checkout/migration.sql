-- CreateEnum
CREATE TYPE "PackagePurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateTable
CREATE TABLE "PackagePurchase" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "status" "PackagePurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "creditAmountSnapshot" INTEGER NOT NULL,
    "priceAmountSnapshot" INTEGER NOT NULL,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'TRY',
    "packageNameSnapshot" TEXT NOT NULL,
    "providerNote" TEXT,
    "adminNote" TEXT,
    "mockPaymentReference" TEXT,
    "mockPaymentFailureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "creditTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackagePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackagePurchase_providerId_idx" ON "PackagePurchase"("providerId");

-- CreateIndex
CREATE INDEX "PackagePurchase_packageId_idx" ON "PackagePurchase"("packageId");

-- CreateIndex
CREATE INDEX "PackagePurchase_status_idx" ON "PackagePurchase"("status");

-- CreateIndex
CREATE INDEX "PackagePurchase_createdAt_idx" ON "PackagePurchase"("createdAt");

-- CreateIndex
CREATE INDEX "PackagePurchase_mockPaymentReference_idx" ON "PackagePurchase"("mockPaymentReference");

-- AddForeignKey
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "OfferCreditPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

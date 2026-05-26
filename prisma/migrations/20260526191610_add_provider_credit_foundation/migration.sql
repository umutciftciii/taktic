-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('ADMIN_GRANT', 'ADMIN_DEDUCT', 'PACKAGE_PURCHASE', 'OFFER_SPEND', 'OFFER_REFUND', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "OfferCreditPackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "creditAmount" INTEGER NOT NULL,
    "priceAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferCreditPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCreditTransaction" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferCreditPackage_slug_key" ON "OfferCreditPackage"("slug");

-- CreateIndex
CREATE INDEX "OfferCreditPackage_isActive_sortOrder_idx" ON "OfferCreditPackage"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_providerId_idx" ON "ProviderCreditTransaction"("providerId");

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_type_idx" ON "ProviderCreditTransaction"("type");

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_referenceType_referenceId_idx" ON "ProviderCreditTransaction"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_createdAt_idx" ON "ProviderCreditTransaction"("createdAt");

-- AddForeignKey
ALTER TABLE "ProviderCreditTransaction" ADD CONSTRAINT "ProviderCreditTransaction_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCreditTransaction" ADD CONSTRAINT "ProviderCreditTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

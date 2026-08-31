-- CreateEnum
CREATE TYPE "OfferPackageType" AS ENUM ('ONE_TIME_CREDITS', 'MONTHLY_QUOTA', 'CATEGORY_UNLIMITED');

-- CreateEnum
CREATE TYPE "ProviderEntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EntitlementRenewalStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "EntitlementRenewalFailureCode" AS ENUM ('PROVIDER_UNSUPPORTED', 'PAYMENT_METHOD_MISSING', 'PAYMENT_DECLINED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'PROVIDER_TIMEOUT', 'AUTO_RENEW_DISABLED', 'ENTITLEMENT_NOT_RENEWABLE');

-- CreateEnum
CREATE TYPE "OfferEntitlementSource" AS ENUM ('UNLIMITED', 'MONTHLY_QUOTA', 'ONE_TIME_CREDIT');

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "entitlementId" TEXT,
ADD COLUMN     "entitlementSource" "OfferEntitlementSource";

-- AlterTable
ALTER TABLE "OfferCreditPackage" ADD COLUMN     "dailyOfferLimit" INTEGER,
ADD COLUMN     "periodDays" INTEGER,
ADD COLUMN     "quotaCredits" INTEGER,
ADD COLUMN     "type" "OfferPackageType" NOT NULL DEFAULT 'ONE_TIME_CREDITS';

-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN     "unlimitedPackageEligible" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OfferPackageScopeCategory" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferPackageScopeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPackageEntitlement" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "type" "OfferPackageType" NOT NULL,
    "packageNameSnapshot" TEXT NOT NULL,
    "priceAmountSnapshot" INTEGER NOT NULL,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'TRY',
    "quotaCreditsSnapshot" INTEGER,
    "remainingQuota" INTEGER,
    "dailyOfferLimitSnapshot" INTEGER,
    "periodDaysSnapshot" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ProviderEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
    "periodIndex" INTEGER NOT NULL DEFAULT 0,
    "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRenewConsentAt" TIMESTAMP(3),
    "paymentMethodReference" TEXT,
    "paymentProvider" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "lastRenewalAttemptAt" TIMESTAMP(3),
    "lastRenewalFailureCode" "EntitlementRenewalFailureCode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderPackageEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPackageEntitlementScope" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryNameSnapshot" TEXT NOT NULL,
    "categoryKindSnapshot" "ServiceCategoryKind" NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPackageEntitlementScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageRenewalAttempt" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "status" "EntitlementRenewalStatus" NOT NULL,
    "failureCode" "EntitlementRenewalFailureCode",
    "paymentProvider" TEXT,
    "providerTransactionRef" TEXT,
    "purchaseId" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageRenewalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfferPackageScopeCategory_categoryId_idx" ON "OfferPackageScopeCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferPackageScopeCategory_packageId_categoryId_key" ON "OfferPackageScopeCategory"("packageId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPackageEntitlement_purchaseId_key" ON "ProviderPackageEntitlement"("purchaseId");

-- CreateIndex
CREATE INDEX "ProviderPackageEntitlement_providerId_status_endAt_idx" ON "ProviderPackageEntitlement"("providerId", "status", "endAt");

-- CreateIndex
CREATE INDEX "ProviderPackageEntitlement_packageId_idx" ON "ProviderPackageEntitlement"("packageId");

-- CreateIndex
CREATE INDEX "ProviderPackageEntitlement_status_endAt_idx" ON "ProviderPackageEntitlement"("status", "endAt");

-- CreateIndex
CREATE INDEX "ProviderPackageEntitlementScope_categoryId_idx" ON "ProviderPackageEntitlementScope"("categoryId");

-- CreateIndex
CREATE INDEX "ProviderPackageEntitlementScope_entitlementId_selected_idx" ON "ProviderPackageEntitlementScope"("entitlementId", "selected");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPackageEntitlementScope_entitlementId_categoryId_key" ON "ProviderPackageEntitlementScope"("entitlementId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "PackageRenewalAttempt_purchaseId_key" ON "PackageRenewalAttempt"("purchaseId");

-- CreateIndex
CREATE INDEX "PackageRenewalAttempt_entitlementId_periodIndex_idx" ON "PackageRenewalAttempt"("entitlementId", "periodIndex");

-- CreateIndex
CREATE INDEX "PackageRenewalAttempt_status_idx" ON "PackageRenewalAttempt"("status");

-- CreateIndex
CREATE INDEX "PackageRenewalAttempt_attemptedAt_idx" ON "PackageRenewalAttempt"("attemptedAt");

-- CreateIndex
CREATE INDEX "Offer_entitlementId_submittedAt_idx" ON "Offer"("entitlementId", "submittedAt");

-- CreateIndex
CREATE INDEX "OfferCreditPackage_type_isActive_sortOrder_idx" ON "OfferCreditPackage"("type", "isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ProviderPackageEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferPackageScopeCategory" ADD CONSTRAINT "OfferPackageScopeCategory_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "OfferCreditPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferPackageScopeCategory" ADD CONSTRAINT "OfferPackageScopeCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPackageEntitlement" ADD CONSTRAINT "ProviderPackageEntitlement_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPackageEntitlement" ADD CONSTRAINT "ProviderPackageEntitlement_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "OfferCreditPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPackageEntitlement" ADD CONSTRAINT "ProviderPackageEntitlement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPackageEntitlementScope" ADD CONSTRAINT "ProviderPackageEntitlementScope_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ProviderPackageEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderPackageEntitlementScope" ADD CONSTRAINT "ProviderPackageEntitlementScope_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRenewalAttempt" ADD CONSTRAINT "PackageRenewalAttempt_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ProviderPackageEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRenewalAttempt" ADD CONSTRAINT "PackageRenewalAttempt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Backfill: every offer that predates entitlements spent a one-time credit.
--
-- Only rows that actually recorded a spend are labelled. An offer with no
-- credit transaction (there are none in the ordinary flow, but the column is
-- nullable) keeps NULL rather than being told a story about what paid for it.
-- ---------------------------------------------------------------------------
UPDATE "Offer"
SET "entitlementSource" = 'ONE_TIME_CREDIT'
WHERE "entitlementSource" IS NULL
  AND "creditSpentTransactionId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The package definition's type invariants, in the database rather than only in
-- the service.
--
-- A ONE_TIME_CREDITS row is exactly what the table held before this migration:
-- a positive credit amount, no quota, no period, no daily cap. The two period
-- types carry no credit amount at all — they grant an entitlement, not a
-- balance — and MONTHLY_QUOTA must carry a positive quota while
-- CATEGORY_UNLIMITED must carry none, because "unlimited with a quota" is not a
-- product, it is a bug somebody would find out about from a support ticket.
-- ---------------------------------------------------------------------------
ALTER TABLE "OfferCreditPackage"
  ADD CONSTRAINT "OfferCreditPackage_type_fields_check" CHECK (
    (
      "type" = 'ONE_TIME_CREDITS'
      AND "creditAmount" > 0
      AND "quotaCredits" IS NULL
      AND "periodDays" IS NULL
      AND "dailyOfferLimit" IS NULL
    )
    OR (
      "type" = 'MONTHLY_QUOTA'
      AND "creditAmount" = 0
      AND "quotaCredits" IS NOT NULL
      AND "quotaCredits" > 0
      AND "periodDays" IS NOT NULL
      AND "periodDays" > 0
    )
    OR (
      "type" = 'CATEGORY_UNLIMITED'
      AND "creditAmount" = 0
      AND "quotaCredits" IS NULL
      AND "periodDays" IS NOT NULL
      AND "periodDays" > 0
    )
  );

ALTER TABLE "OfferCreditPackage"
  ADD CONSTRAINT "OfferCreditPackage_dailyOfferLimit_check" CHECK (
    "dailyOfferLimit" IS NULL OR "dailyOfferLimit" > 0
  );

-- ---------------------------------------------------------------------------
-- The entitlement's own invariants.
--
-- A period that ends before it starts is not a period, and a MONTHLY_QUOTA
-- entitlement whose remaining quota went negative would mean the atomic
-- decrement failed to be atomic. Both are unrepresentable here rather than
-- merely unlikely.
-- ---------------------------------------------------------------------------
ALTER TABLE "ProviderPackageEntitlement"
  ADD CONSTRAINT "ProviderPackageEntitlement_period_check" CHECK ("endAt" > "startAt");

ALTER TABLE "ProviderPackageEntitlement"
  ADD CONSTRAINT "ProviderPackageEntitlement_quota_check" CHECK (
    (
      "type" = 'MONTHLY_QUOTA'
      AND "quotaCreditsSnapshot" IS NOT NULL
      AND "quotaCreditsSnapshot" > 0
      AND "remainingQuota" IS NOT NULL
      AND "remainingQuota" >= 0
      AND "remainingQuota" <= "quotaCreditsSnapshot"
    )
    OR (
      "type" <> 'MONTHLY_QUOTA'
      AND "quotaCreditsSnapshot" IS NULL
      AND "remainingQuota" IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- One period may be bought once.
--
-- Two crons firing together, a webhook redelivered, an operator clicking twice:
-- all of them try to write a SUCCEEDED attempt for the same (entitlement,
-- period). The partial unique index makes the second one a constraint
-- violation instead of a second charge and a second 30 days.
--
-- Partial rather than total on purpose: failed and unsupported attempts must be
-- allowed to repeat, because they are the audit trail of a period that kept
-- failing to renew.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "PackageRenewalAttempt_one_success_per_period"
  ON "PackageRenewalAttempt" ("entitlementId", "periodIndex")
  WHERE "status" = 'SUCCEEDED';

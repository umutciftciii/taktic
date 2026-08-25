-- Test-mode payment provider checkout for provider credit packages.
--
-- Every column added here is either an opaque provider reference or a flag for a
-- human. No raw webhook payload, no signature, no API credential and no customer
-- personal data is stored by this feature.

-- CreateEnum
CREATE TYPE "PaymentWebhookEventStatus" AS ENUM ('PROCESSED', 'DUPLICATE', 'IGNORED', 'MISMATCHED', 'MANUAL_REVIEW_REQUIRED');

-- AlterTable
ALTER TABLE "PackagePurchase"
  ADD COLUMN "paymentProvider" TEXT,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "providerCheckoutId" TEXT,
  ADD COLUMN "providerCheckoutUrl" TEXT,
  ADD COLUMN "providerCheckoutExpiresAt" TIMESTAMP(3),
  ADD COLUMN "providerOrderId" TEXT,
  ADD COLUMN "paymentFailureCode" TEXT,
  ADD COLUMN "manualReviewReason" TEXT,
  ADD COLUMN "manualReviewAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "status" "PaymentWebhookEventStatus" NOT NULL,
    "purchaseId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchase_paymentReference_key" ON "PackagePurchase"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchase_providerOrderId_key" ON "PackagePurchase"("providerOrderId");

-- CreateIndex
CREATE INDEX "PackagePurchase_paymentProvider_status_idx" ON "PackagePurchase"("paymentProvider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventKey_key" ON "PaymentWebhookEvent"("provider", "eventKey");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_status_idx" ON "PaymentWebhookEvent"("status");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_purchaseId_idx" ON "PaymentWebhookEvent"("purchaseId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_createdAt_idx" ON "PaymentWebhookEvent"("createdAt");

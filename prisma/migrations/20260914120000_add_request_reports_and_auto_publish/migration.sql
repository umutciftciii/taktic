-- CreateEnum
CREATE TYPE "ServiceRequestReportReason" AS ENUM ('SPAM', 'FAKE_OR_TEST', 'CONTAINS_CONTACT_INFO', 'WRONG_CATEGORY', 'INAPPROPRIATE_CONTENT', 'DUPLICATE', 'OTHER');
CREATE TYPE "ServiceRequestReportResolution" AS ENUM ('DISMISSED', 'REQUEST_REMOVED');

-- AlterTable: additive, defaulted / nullable. No row is rewritten.
ALTER TABLE "OperationsSettings" ADD COLUMN "marketplaceAutoPublishEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Offer" ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ServiceRequestReport" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "reporterProviderId" TEXT NOT NULL,
    "reason" "ServiceRequestReportReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" "ServiceRequestReportResolution",
    "resolutionNote" TEXT,

    CONSTRAINT "ServiceRequestReport_pkey" PRIMARY KEY ("id"),
    -- A resolution and its timestamp are one fact: neither may exist alone.
    CONSTRAINT "ServiceRequestReport_resolution_pair" CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestReport_requestId_reporterProviderId_key" ON "ServiceRequestReport"("requestId", "reporterProviderId");
CREATE INDEX "ServiceRequestReport_requestId_idx" ON "ServiceRequestReport"("requestId");
CREATE INDEX "ServiceRequestReport_reporterProviderId_createdAt_idx" ON "ServiceRequestReport"("reporterProviderId", "createdAt");
CREATE INDEX "ServiceRequestReport_resolvedAt_createdAt_idx" ON "ServiceRequestReport"("resolvedAt", "createdAt");
-- The open queue, oldest first. Partial: resolved rows never enter it.
CREATE INDEX "ServiceRequestReport_open_idx" ON "ServiceRequestReport"("createdAt") WHERE "resolvedAt" IS NULL;
CREATE INDEX "ServiceRequest_customerPhone_submittedAt_idx" ON "ServiceRequest"("customerPhone", "submittedAt");

-- AddForeignKey
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_reporterProviderId_fkey" FOREIGN KEY ("reporterProviderId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestReport" ADD CONSTRAINT "ServiceRequestReport_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

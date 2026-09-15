-- Additive only: three new tables, one defaulted column on the singleton settings row. No row is rewritten.

-- CreateEnum
CREATE TYPE "ProviderReviewReportReason" AS ENUM ('OFFENSIVE', 'CONTAINS_CONTACT_INFO', 'NOT_ABOUT_THIS_JOB', 'SUSPECTED_FAKE', 'OTHER');

-- CreateEnum
CREATE TYPE "ProviderReviewModerationAction" AS ENUM ('REMOVE_COMMENT', 'REMOVE_REVIEW', 'RESTORE');

-- CreateEnum
CREATE TYPE "ProviderReviewReportResolution" AS ENUM ('DISMISSED', 'COMMENT_REMOVED', 'REVIEW_REMOVED');

-- AlterTable
ALTER TABLE "OperationsSettings" ADD COLUMN     "providerReviewsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProviderReview" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "commentRemovedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderReviewReport" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reporterProviderId" TEXT NOT NULL,
    "reason" "ProviderReviewReportReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" "ProviderReviewReportResolution",
    "resolutionNote" TEXT,

    CONSTRAINT "ProviderReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderReviewModeration" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "action" "ProviderReviewModerationAction" NOT NULL,
    "reason" "ProviderReviewReportReason",
    "note" TEXT,
    "performedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderReviewModeration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderReview_offerId_key" ON "ProviderReview"("offerId");

-- CreateIndex
CREATE INDEX "ProviderReview_customerUserId_createdAt_idx" ON "ProviderReview"("customerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReview_providerId_createdAt_idx" ON "ProviderReview"("providerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderReview_requestId_providerId_key" ON "ProviderReview"("requestId", "providerId");

-- CreateIndex
CREATE INDEX "ProviderReviewReport_reviewId_createdAt_idx" ON "ProviderReviewReport"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReviewReport_reporterProviderId_createdAt_idx" ON "ProviderReviewReport"("reporterProviderId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReviewReport_resolvedAt_createdAt_idx" ON "ProviderReviewReport"("resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReviewModeration_reviewId_createdAt_idx" ON "ProviderReviewModeration"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReviewModeration_performedById_idx" ON "ProviderReviewModeration"("performedById");

-- AddForeignKey
ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReview" ADD CONSTRAINT "ProviderReview_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReviewReport" ADD CONSTRAINT "ProviderReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ProviderReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReviewReport" ADD CONSTRAINT "ProviderReviewReport_reporterProviderId_fkey" FOREIGN KEY ("reporterProviderId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReviewReport" ADD CONSTRAINT "ProviderReviewReport_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReviewModeration" ADD CONSTRAINT "ProviderReviewModeration_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "ProviderReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReviewModeration" ADD CONSTRAINT "ProviderReviewModeration_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL Prisma cannot express: CHECK constraints and partial indexes.
ALTER TABLE "ProviderReview"
  ADD CONSTRAINT "ProviderReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "ProviderReview_comment_removal_needs_comment"
    CHECK ("commentRemovedAt" IS NULL OR "comment" IS NOT NULL);
ALTER TABLE "ProviderReviewReport"
  ADD CONSTRAINT "ProviderReviewReport_resolution_pair"
    CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL));
ALTER TABLE "ProviderReviewModeration"
  ADD CONSTRAINT "ProviderReviewModeration_reason_by_action"
    CHECK (("action" = 'RESTORE') = ("reason" IS NULL));
-- Aggregate + public list: live rows only, index-only for count/avg.
CREATE INDEX "ProviderReview_live_by_provider_idx"
  ON "ProviderReview"("providerId", "createdAt" DESC) INCLUDE ("rating")
  WHERE "removedAt" IS NULL;
-- One open report per review; a new one may follow a decision.
CREATE UNIQUE INDEX "ProviderReviewReport_one_open_per_review"
  ON "ProviderReviewReport"("reviewId") WHERE "resolvedAt" IS NULL;
-- The open queue, oldest first.
CREATE INDEX "ProviderReviewReport_open_idx"
  ON "ProviderReviewReport"("createdAt") WHERE "resolvedAt" IS NULL;

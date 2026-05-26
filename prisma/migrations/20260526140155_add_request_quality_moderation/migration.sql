-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderationNote" TEXT,
ADD COLUMN     "qualityScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "qualityScoreBreakdown" JSONB,
ADD COLUMN     "rejectionReason" TEXT;

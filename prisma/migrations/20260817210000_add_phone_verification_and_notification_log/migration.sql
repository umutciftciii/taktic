-- Phone verification and outbound notification audit.
--
-- Fully additive: two new tables, two new enums, one nullable column and a set
-- of indexes. Nothing existing is renamed, dropped or backfilled — every
-- request created before this migration simply keeps phoneVerifiedAt = NULL,
-- which is the honest representation of "never verified". What that state
-- blocks is decided at runtime by REQUIRE_PHONE_VERIFICATION, which defaults to
-- false, so applying this migration changes no behaviour on its own.
--
-- PhoneVerification stores only a bcrypt hash of the code, never the code, and
-- deliberately carries NO unique constraint on codeHash: six-digit codes
-- collide, and a unique index would both reject legitimate codes and leak that
-- a given code is already in flight.
--
-- NotificationLog stores no code, token, action URL, message body, or raw
-- phone/e-mail — only a masked recipient and a safe failure class.

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PhoneVerification" (
    "id" TEXT NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "maskedRecipient" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "requestId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhoneVerification_normalizedPhone_createdAt_idx" ON "PhoneVerification"("normalizedPhone", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneVerification_ipAddress_createdAt_idx" ON "PhoneVerification"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneVerification_requestId_idx" ON "PhoneVerification"("requestId");

-- CreateIndex
CREATE INDEX "PhoneVerification_expiresAt_idx" ON "PhoneVerification"("expiresAt");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_createdAt_idx" ON "NotificationLog"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_status_createdAt_idx" ON "NotificationLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_template_createdAt_idx" ON "NotificationLog"("template", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_requestId_idx" ON "NotificationLog"("requestId");

-- CreateIndex
CREATE INDEX "NotificationLog_userId_idx" ON "NotificationLog"("userId");

-- CreateIndex
CREATE INDEX "ServiceRequest_phoneVerifiedAt_idx" ON "ServiceRequest"("phoneVerifiedAt");

-- AddForeignKey
ALTER TABLE "PhoneVerification" ADD CONSTRAINT "PhoneVerification_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


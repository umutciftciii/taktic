-- Guest provider application claim: the one-time invitation table, the marker
-- that says an application became owned through it, and the audit link from a
-- notification back to the application it was about.
--
-- Fully additive: two nullable columns and one new table. Nothing is renamed,
-- dropped or rewritten, and applying this migration changes no behaviour on its
-- own — PROVIDER_CLAIM_ENABLED defaults to false, and with the flag off no
-- token is ever issued and no claim endpoint answers.
--
-- Deliberately NOT backfilled. An application that was already owned when this
-- ran was not claimed, so ProviderProfile.claimedAt stays NULL for it; every
-- notification written before NotificationLog.providerId existed keeps NULL
-- rather than being attributed to an application by guesswork.

-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "providerId" TEXT;

-- CreateTable
CREATE TABLE "ProviderClaimToken" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderClaimToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The lookup key. Unique because the stored value is a sha256 digest of a
-- 256-bit random token: a collision would mean two live links opening the same
-- door, and the constraint makes that unrepresentable rather than unlikely.
CREATE UNIQUE INDEX "ProviderClaimToken_tokenHash_key" ON "ProviderClaimToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ProviderClaimToken_providerId_idx" ON "ProviderClaimToken"("providerId");

-- CreateIndex
CREATE INDEX "ProviderClaimToken_createdById_idx" ON "ProviderClaimToken"("createdById");

-- CreateIndex
CREATE INDEX "ProviderClaimToken_expiresAt_idx" ON "ProviderClaimToken"("expiresAt");

-- CreateIndex
-- Per-application send budget: "links issued for this application since
-- <cutoff>".
CREATE INDEX "ProviderClaimToken_providerId_createdAt_idx" ON "ProviderClaimToken"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_providerId_idx" ON "NotificationLog"("providerId");

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderClaimToken" ADD CONSTRAINT "ProviderClaimToken_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderClaimToken" ADD CONSTRAINT "ProviderClaimToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

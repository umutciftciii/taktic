-- CMP-003 S3 (Migration F): campaign revoke operations.
--
-- Purely additive: three values appended to "CampaignAuditAction", one
-- nullable column on "CampaignVersion", two nullable columns (one with a
-- foreign key) on "CampaignRedemption", and one new counter table. No
-- existing column changes type, nullability or default, nothing is dropped,
-- and no row is read, written, converted or seeded. Every campaign table is
-- empty in every real environment (the engine has never been on); a row that
-- did exist would read "no threshold, not revoked by a webhook, no note".
--
-- ADD VALUE inside the migration's transaction is fine on PostgreSQL 12+ as
-- long as the same transaction does not use the new value, and nothing below
-- does (the add_campaign_lifecycle_audit_actions migration set the precedent).
--
-- "CreditTransactionType" is not touched: the revoke writes the existing
-- CAMPAIGN_REVOKE value through the S2B1 primitive.

ALTER TYPE "CampaignAuditAction" ADD VALUE 'AUTO_PAUSED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'REDEMPTION_REVOKED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'EVENT_RETRY_REQUESTED';

-- The optional daily revoke threshold of an immutable version. NULL = off.
ALTER TABLE "CampaignVersion" ADD COLUMN "maxRevokesPerDay" INTEGER;
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_maxRevokesPerDay_bounded"
  CHECK ("maxRevokesPerDay" IS NULL OR ("maxRevokesPerDay" >= 1 AND "maxRevokesPerDay" <= 1000));

-- Who or what revoked a redemption: an operator's bounded reason, or the
-- verified payment webhook event whose reversal did it.
ALTER TABLE "CampaignRedemption"
  ADD COLUMN "revokeNote" TEXT,
  ADD COLUMN "revokedByWebhookEventId" TEXT;
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_revokeNote_bounded"
  CHECK ("revokeNote" IS NULL OR (char_length("revokeNote") >= 1 AND char_length("revokeNote") <= 500));
ALTER TABLE "CampaignRedemption" ADD CONSTRAINT "CampaignRedemption_revokedByWebhookEventId_fkey"
  FOREIGN KEY ("revokedByWebhookEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "CampaignRedemption_revokedByWebhookEventId_idx" ON "CampaignRedemption"("revokedByWebhookEventId");

-- The database half of maxRevokesPerDay: one row per campaign and UTC day,
-- moved by a conditional increment inside the revoke's own transaction.
CREATE TABLE "CampaignRevokeDailyCounter" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "revokeCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRevokeDailyCounter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignRevokeDailyCounter_campaignId_day_key" ON "CampaignRevokeDailyCounter"("campaignId", "day");
ALTER TABLE "CampaignRevokeDailyCounter" ADD CONSTRAINT "CampaignRevokeDailyCounter_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignRevokeDailyCounter" ADD CONSTRAINT "CampaignRevokeDailyCounter_revokeCount_nonnegative"
  CHECK ("revokeCount" >= 0);

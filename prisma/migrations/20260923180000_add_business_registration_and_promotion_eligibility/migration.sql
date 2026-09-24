-- CMP-006 PR-C — Migration K: canonical business registration and the
-- promotion eligibility gate.
--
-- Additive only. No DML: no ProviderBusinessRegistration row is born here.
-- A provider without one is "unspecified" (a legacy record), and the free-text
-- ProviderProfile.taxType/taxNumber are neither converted nor touched.
--
-- What the database guarantees on its own:
--   1. NONE_DECLARED carries no number, mask or fingerprint; every other type
--      carries all four (CHECK). The number is stored in one table only.
--   2. The registration change history, the sensitive-read log, the hold
--      snapshot and the review decision are append-only (triggers).
--   3. A review names the hold of its own event and provider (trigger), is
--      unique per event and per hold, and carries a 10–1000 character reason
--      (CHECK).
--   4. The registration counter holds a type and a versioned fingerprint —
--      there is no column for a number.
--
-- The new enum values (two AdminPermission, HELD_FOR_REVIEW, two outcomes) are
-- added but not used here: a value added by ALTER TYPE cannot be used in the
-- same transaction.

-- CreateEnum
CREATE TYPE "BusinessRegistrationType" AS ENUM ('TRADE_REGISTRY', 'MERSIS', 'TAX_NUMBER', 'CRAFTSMAN_REGISTRY', 'SOLE_PROPRIETOR_TR_ID', 'NONE_DECLARED');

-- CreateEnum
CREATE TYPE "ProviderBusinessRegistrationActor" AS ENUM ('APPLICANT', 'PROVIDER');

-- CreateEnum
CREATE TYPE "SensitiveDataSubject" AS ENUM ('PROVIDER_BUSINESS_REGISTRATION');

-- CreateEnum
CREATE TYPE "PromotionEligibilityDecision" AS ENUM ('ELIGIBLE', 'INELIGIBLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminPermission" ADD VALUE 'PROVIDER_REGISTRATION_READ_SENSITIVE';
ALTER TYPE "AdminPermission" ADD VALUE 'PROMOTION_ELIGIBILITY_REVIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignEvaluationOutcome" ADD VALUE 'PROMOTION_REVIEW_HELD';
ALTER TYPE "CampaignEvaluationOutcome" ADD VALUE 'PROMOTION_INELIGIBLE';

-- AlterEnum
ALTER TYPE "CampaignTriggerEventStatus" ADD VALUE 'HELD_FOR_REVIEW';

-- CreateTable
CREATE TABLE "ProviderBusinessRegistration" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "BusinessRegistrationType" NOT NULL,
    "numberCanonical" TEXT,
    "numberMasked" TEXT,
    "fingerprint" TEXT,
    "fingerprintVersion" INTEGER,
    "declaredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderBusinessRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBusinessRegistrationChange" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "actorKind" "ProviderBusinessRegistrationActor" NOT NULL,
    "actorUserId" TEXT,
    "previousType" "BusinessRegistrationType",
    "previousFingerprint" TEXT,
    "previousFingerprintVersion" INTEGER,
    "newType" "BusinessRegistrationType" NOT NULL,
    "newFingerprint" TEXT,
    "newFingerprintVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderBusinessRegistrationChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensitiveDataAccessLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "subject" "SensitiveDataSubject" NOT NULL,
    "providerId" TEXT NOT NULL,
    "fields" TEXT[],
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensitiveDataAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRegistrationCounter" (
    "id" TEXT NOT NULL,
    "registrationType" "BusinessRegistrationType" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "firstRedemptionId" TEXT NOT NULL,
    "lastRedemptionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRegistrationCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionEligibilityHold" (
    "id" TEXT NOT NULL,
    "triggerEventId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "snapshotVersion" INTEGER NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionEligibilityHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionEligibilityReview" (
    "id" TEXT NOT NULL,
    "triggerEventId" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "decision" "PromotionEligibilityDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionEligibilityReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderBusinessRegistration_providerId_key" ON "ProviderBusinessRegistration"("providerId");

-- CreateIndex
CREATE INDEX "ProviderBusinessRegistration_type_fingerprint_fingerprintVe_idx" ON "ProviderBusinessRegistration"("type", "fingerprint", "fingerprintVersion");

-- CreateIndex
CREATE INDEX "ProviderBusinessRegistration_declaredByUserId_idx" ON "ProviderBusinessRegistration"("declaredByUserId");

-- CreateIndex
CREATE INDEX "ProviderBusinessRegistrationChange_providerId_createdAt_idx" ON "ProviderBusinessRegistrationChange"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderBusinessRegistrationChange_actorUserId_idx" ON "ProviderBusinessRegistrationChange"("actorUserId");

-- CreateIndex
CREATE INDEX "SensitiveDataAccessLog_providerId_readAt_idx" ON "SensitiveDataAccessLog"("providerId", "readAt");

-- CreateIndex
CREATE INDEX "SensitiveDataAccessLog_actorId_readAt_idx" ON "SensitiveDataAccessLog"("actorId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRegistrationCounter_firstRedemptionId_key" ON "CampaignRegistrationCounter"("firstRedemptionId");

-- CreateIndex
CREATE INDEX "CampaignRegistrationCounter_providerId_idx" ON "CampaignRegistrationCounter"("providerId");

-- CreateIndex
CREATE INDEX "CampaignRegistrationCounter_lastRedemptionId_idx" ON "CampaignRegistrationCounter"("lastRedemptionId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRegistrationCounter_registrationType_fingerprint_fi_key" ON "CampaignRegistrationCounter"("registrationType", "fingerprint", "fingerprintVersion", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionEligibilityHold_triggerEventId_key" ON "PromotionEligibilityHold"("triggerEventId");

-- CreateIndex
CREATE INDEX "PromotionEligibilityHold_providerId_heldAt_idx" ON "PromotionEligibilityHold"("providerId", "heldAt");

-- CreateIndex
CREATE INDEX "PromotionEligibilityHold_heldAt_idx" ON "PromotionEligibilityHold"("heldAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionEligibilityReview_triggerEventId_key" ON "PromotionEligibilityReview"("triggerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionEligibilityReview_holdId_key" ON "PromotionEligibilityReview"("holdId");

-- CreateIndex
CREATE INDEX "PromotionEligibilityReview_providerId_decidedAt_idx" ON "PromotionEligibilityReview"("providerId", "decidedAt");

-- CreateIndex
CREATE INDEX "PromotionEligibilityReview_decidedById_idx" ON "PromotionEligibilityReview"("decidedById");

-- AddForeignKey
ALTER TABLE "ProviderBusinessRegistration" ADD CONSTRAINT "ProviderBusinessRegistration_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBusinessRegistration" ADD CONSTRAINT "ProviderBusinessRegistration_declaredByUserId_fkey" FOREIGN KEY ("declaredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBusinessRegistrationChange" ADD CONSTRAINT "ProviderBusinessRegistrationChange_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBusinessRegistrationChange" ADD CONSTRAINT "ProviderBusinessRegistrationChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensitiveDataAccessLog" ADD CONSTRAINT "SensitiveDataAccessLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensitiveDataAccessLog" ADD CONSTRAINT "SensitiveDataAccessLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRegistrationCounter" ADD CONSTRAINT "CampaignRegistrationCounter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRegistrationCounter" ADD CONSTRAINT "CampaignRegistrationCounter_firstRedemptionId_fkey" FOREIGN KEY ("firstRedemptionId") REFERENCES "CampaignRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRegistrationCounter" ADD CONSTRAINT "CampaignRegistrationCounter_lastRedemptionId_fkey" FOREIGN KEY ("lastRedemptionId") REFERENCES "CampaignRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityHold" ADD CONSTRAINT "PromotionEligibilityHold_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "CampaignTriggerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityHold" ADD CONSTRAINT "PromotionEligibilityHold_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityReview" ADD CONSTRAINT "PromotionEligibilityReview_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "CampaignTriggerEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityReview" ADD CONSTRAINT "PromotionEligibilityReview_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "PromotionEligibilityHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityReview" ADD CONSTRAINT "PromotionEligibilityReview_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionEligibilityReview" ADD CONSTRAINT "PromotionEligibilityReview_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK: the number columns follow the type.
ALTER TABLE "ProviderBusinessRegistration" ADD CONSTRAINT "ProviderBusinessRegistration_number_matches_type" CHECK (
  ("type" = 'NONE_DECLARED'
     AND "numberCanonical" IS NULL AND "numberMasked" IS NULL
     AND "fingerprint" IS NULL AND "fingerprintVersion" IS NULL)
  OR
  ("type" <> 'NONE_DECLARED'
     AND "numberCanonical" ~ '^[0-9]{1,16}$'
     AND "numberMasked" IS NOT NULL AND char_length("numberMasked") = char_length("numberCanonical")
     AND "fingerprint" ~ '^[0-9a-f]{64}$' AND "fingerprintVersion" >= 1)
);

ALTER TABLE "ProviderBusinessRegistrationChange" ADD CONSTRAINT "ProviderBusinessRegistrationChange_fingerprints" CHECK (
  ("newFingerprint" IS NULL) = ("newFingerprintVersion" IS NULL)
  AND ("previousFingerprint" IS NULL) = ("previousFingerprintVersion" IS NULL)
  AND ("newType" = 'NONE_DECLARED') = ("newFingerprint" IS NULL)
);

ALTER TABLE "CampaignRegistrationCounter" ADD CONSTRAINT "CampaignRegistrationCounter_fingerprint_shape" CHECK (
  "registrationType" <> 'NONE_DECLARED'
  AND "fingerprint" ~ '^[0-9a-f]{64}$'
  AND "fingerprintVersion" >= 1
  AND "redemptionCount" >= 1
);

ALTER TABLE "SensitiveDataAccessLog" ADD CONSTRAINT "SensitiveDataAccessLog_fields_present" CHECK (
  cardinality("fields") BETWEEN 1 AND 8
);

ALTER TABLE "PromotionEligibilityHold" ADD CONSTRAINT "PromotionEligibilityHold_snapshot_shape" CHECK (
  jsonb_typeof("signals") = 'object' AND "snapshotVersion" >= 1
);

ALTER TABLE "PromotionEligibilityReview" ADD CONSTRAINT "PromotionEligibilityReview_reason_length" CHECK (
  char_length(btrim("reason")) BETWEEN 10 AND 1000
);

-- Trigger: append-only tables. (TRUNCATE, which only test harnesses issue,
-- does not fire row triggers.)
CREATE FUNCTION "cmp006_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProviderBusinessRegistrationChange_append_only"
  BEFORE UPDATE OR DELETE ON "ProviderBusinessRegistrationChange"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "SensitiveDataAccessLog_append_only"
  BEFORE UPDATE OR DELETE ON "SensitiveDataAccessLog"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "PromotionEligibilityHold_append_only"
  BEFORE UPDATE OR DELETE ON "PromotionEligibilityHold"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

CREATE TRIGGER "PromotionEligibilityReview_append_only"
  BEFORE UPDATE OR DELETE ON "PromotionEligibilityReview"
  FOR EACH ROW EXECUTE FUNCTION "cmp006_append_only_fn"();

-- Trigger: a review decides the hold of its own event and provider.
CREATE FUNCTION "PromotionEligibilityReview_insert_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold_event TEXT;
  hold_provider TEXT;
BEGIN
  SELECT h."triggerEventId", h."providerId" INTO hold_event, hold_provider
    FROM "PromotionEligibilityHold" h WHERE h."id" = NEW."holdId";
  IF hold_event IS DISTINCT FROM NEW."triggerEventId" OR hold_provider IS DISTINCT FROM NEW."providerId" THEN
    RAISE EXCEPTION 'PromotionEligibilityReview must decide the hold of its own event and provider'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PromotionEligibilityReview_insert_guard"
  BEFORE INSERT ON "PromotionEligibilityReview"
  FOR EACH ROW EXECUTE FUNCTION "PromotionEligibilityReview_insert_guard_fn"();

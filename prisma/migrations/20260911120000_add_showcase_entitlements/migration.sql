-- VIT-DESIGN-002: the package is bought first; the right it grants is spent at
-- the card's first approval.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Data effect on rows that already exist: none.
-- ────────────────────────────────────────────────────────────────────────────
-- No row of any table is read, updated or deleted by this file. Every change
-- is a new column with a default, a new nullable column, a new table, a new
-- index, or a CHECK that every existing row already satisfies:
--   * ShowcasePackage.activationWindowDays gets 90 on every existing package.
--   * PackagePurchase.showcasePackageTermsAcceptanceId is NULL everywhere, so
--     every OFFER_PACKAGE row satisfies the first branch of the rewritten CHECK
--     and every existing SHOWCASE_PACKAGE row (card-bound by construction)
--     satisfies the legacy branch.

-- CreateEnum
CREATE TYPE "ShowcaseEntitlementStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED', 'EXPIRED');
CREATE TYPE "ShowcaseEntitlementPauseEnd" AS ENUM ('REJECTED', 'WITHDRAWN', 'RELEASED', 'CONSUMED');

-- AlterTable: the activation window. A default rather than a backfill, so the
-- statement is catalogue-only and no package row is rewritten.
ALTER TABLE "ShowcasePackage"
  ADD COLUMN "activationWindowDays" INTEGER NOT NULL DEFAULT 90;

ALTER TABLE "ShowcasePackage"
  ADD CONSTRAINT "ShowcasePackage_activation_window_positive"
    CHECK ("activationWindowDays" > 0);

-- CreateTable: provider-level acceptance for the package-first sale.
CREATE TABLE "ShowcasePackageTermsAcceptance" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsTextSnapshot" TEXT NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePackageTermsAcceptance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShowcasePackageTermsAcceptance"
  ADD CONSTRAINT "ShowcasePackageTermsAcceptance_version_not_blank"
    CHECK (btrim("termsVersion") <> ''),
  ADD CONSTRAINT "ShowcasePackageTermsAcceptance_text_not_blank"
    CHECK (btrim("termsTextSnapshot") <> '');

CREATE UNIQUE INDEX "ShowcasePackageTermsAcceptance_providerId_termsVersion_key"
  ON "ShowcasePackageTermsAcceptance"("providerId", "termsVersion");
CREATE INDEX "ShowcasePackageTermsAcceptance_termsVersion_acceptedAt_idx"
  ON "ShowcasePackageTermsAcceptance"("termsVersion", "acceptedAt");

ALTER TABLE "ShowcasePackageTermsAcceptance" ADD CONSTRAINT "ShowcasePackageTermsAcceptance_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePackageTermsAcceptance" ADD CONSTRAINT "ShowcasePackageTermsAcceptance_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: the purchase names which acceptance it was opened against.
ALTER TABLE "PackagePurchase"
  ADD COLUMN "showcasePackageTermsAcceptanceId" TEXT;

ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcasePackageTermsAcceptanceId_fkey"
  FOREIGN KEY ("showcasePackageTermsAcceptanceId") REFERENCES "ShowcasePackageTermsAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PackagePurchase_showcasePackageTermsAcceptanceId_idx"
  ON "PackagePurchase"("showcasePackageTermsAcceptanceId");

-- The discriminator CHECK, rewritten so a SHOWCASE_PACKAGE row is either the
-- legacy card-bound shape or the package-first shape — never a mixture, never
-- neither. Dropped and recreated so exactly one constraint answers the question.
ALTER TABLE "PackagePurchase"
  DROP CONSTRAINT "PackagePurchase_showcase_card_matches_kind";

ALTER TABLE "PackagePurchase"
  ADD CONSTRAINT "PackagePurchase_showcase_card_matches_kind" CHECK (
    ("kind" = 'OFFER_PACKAGE'
       AND "showcaseCardId" IS NULL
       AND "showcaseCardVersionId" IS NULL
       AND "durationDaysSnapshot" IS NULL
       AND "showcasePriceTermsAcceptanceId" IS NULL
       AND "showcasePackageTermsAcceptanceId" IS NULL)
    OR
    ("kind" = 'SHOWCASE_PACKAGE'
       AND "durationDaysSnapshot" IS NOT NULL
       AND (
         -- legacy, card-bound purchase: history only, nothing writes it any more
         ("showcaseCardId" IS NOT NULL
            AND "showcaseCardVersionId" IS NOT NULL
            AND "showcasePriceTermsAcceptanceId" IS NOT NULL
            AND "showcasePackageTermsAcceptanceId" IS NULL)
         OR
         -- package-first purchase
         ("showcaseCardId" IS NULL
            AND "showcaseCardVersionId" IS NULL
            AND "showcasePriceTermsAcceptanceId" IS NULL
            AND "showcasePackageTermsAcceptanceId" IS NOT NULL)
       ))
  );

-- CreateTable: the right itself.
CREATE TABLE "ShowcaseEntitlement" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "showcasePackageId" TEXT NOT NULL,
    "packageNameSnapshot" TEXT NOT NULL,
    "durationDaysSnapshot" INTEGER NOT NULL,
    "priceAmountSnapshot" INTEGER NOT NULL,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'TRY',
    "allowedCardKindSnapshot" "ShowcaseCardKind",
    "maxAreasSnapshot" INTEGER,
    "priceTermsVersionSnapshot" TEXT NOT NULL,
    "priceTermsTextSnapshot" TEXT NOT NULL,
    "status" "ShowcaseEntitlementStatus" NOT NULL DEFAULT 'AVAILABLE',
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cardId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "placementId" TEXT,
    "reviewPausedAt" TIMESTAMP(3),
    "totalPausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcaseEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowcaseEntitlement_purchaseId_key" ON "ShowcaseEntitlement"("purchaseId");
CREATE UNIQUE INDEX "ShowcaseEntitlement_placementId_key" ON "ShowcaseEntitlement"("placementId");
CREATE INDEX "ShowcaseEntitlement_providerId_status_expiresAt_idx"
  ON "ShowcaseEntitlement"("providerId", "status", "expiresAt");
CREATE INDEX "ShowcaseEntitlement_cardId_idx" ON "ShowcaseEntitlement"("cardId");

-- One card, one reserved right at a time. The reservation itself is a
-- conditional update on status = AVAILABLE, so two cards racing for one right
-- are refused by the row; this index refuses two rights racing for one card.
CREATE UNIQUE INDEX "ShowcaseEntitlement_one_reserved_per_card"
  ON "ShowcaseEntitlement"("cardId") WHERE "status" = 'RESERVED';

ALTER TABLE "ShowcaseEntitlement"
  ADD CONSTRAINT "ShowcaseEntitlement_window_positive" CHECK ("expiresAt" > "grantedAt"),
  ADD CONSTRAINT "ShowcaseEntitlement_status_shape" CHECK (
    ("status" = 'AVAILABLE' AND "cardId" IS NULL AND "reservedAt" IS NULL
       AND "consumedAt" IS NULL AND "placementId" IS NULL AND "reviewPausedAt" IS NULL)
    OR
    ("status" = 'RESERVED' AND "cardId" IS NOT NULL AND "reservedAt" IS NOT NULL
       AND "consumedAt" IS NULL AND "placementId" IS NULL)
    OR
    ("status" = 'CONSUMED' AND "cardId" IS NOT NULL AND "reservedAt" IS NOT NULL
       AND "consumedAt" IS NOT NULL AND "placementId" IS NOT NULL AND "reviewPausedAt" IS NULL)
    OR
    ("status" = 'EXPIRED' AND "consumedAt" IS NULL AND "placementId" IS NULL
       AND "reviewPausedAt" IS NULL)
  );

ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_showcasePackageId_fkey"
  FOREIGN KEY ("showcasePackageId") REFERENCES "ShowcasePackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlement" ADD CONSTRAINT "ShowcaseEntitlement_placementId_fkey"
  FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: the audit of every review pause.
CREATE TABLE "ShowcaseEntitlementReviewPause" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "expiresAtBefore" TIMESTAMP(3) NOT NULL,
    "expiresAtAfter" TIMESTAMP(3),
    "endReason" "ShowcaseEntitlementPauseEnd",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseEntitlementReviewPause_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShowcaseEntitlementReviewPause_entitlementId_startedAt_idx"
  ON "ShowcaseEntitlementReviewPause"("entitlementId", "startedAt");
CREATE UNIQUE INDEX "ShowcaseEntitlementReviewPause_one_open"
  ON "ShowcaseEntitlementReviewPause"("entitlementId") WHERE "endedAt" IS NULL;

-- Open and closed are the two shapes, and nothing in between.
ALTER TABLE "ShowcaseEntitlementReviewPause"
  ADD CONSTRAINT "ShowcaseEntitlementReviewPause_closed_shape" CHECK (
    ("endedAt" IS NULL AND "expiresAtAfter" IS NULL AND "endReason" IS NULL)
    OR
    ("endedAt" IS NOT NULL AND "expiresAtAfter" IS NOT NULL AND "endReason" IS NOT NULL
       AND "endedAt" >= "startedAt" AND "expiresAtAfter" >= "expiresAtBefore")
  );

ALTER TABLE "ShowcaseEntitlementReviewPause" ADD CONSTRAINT "ShowcaseEntitlementReviewPause_entitlementId_fkey"
  FOREIGN KEY ("entitlementId") REFERENCES "ShowcaseEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseEntitlementReviewPause" ADD CONSTRAINT "ShowcaseEntitlementReviewPause_cardVersionId_fkey"
  FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

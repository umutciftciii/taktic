-- SHOWCASE-ALLOWANCE-001: per-package free vitrin offer count.
--
-- What this adds:
--
--   * ShowcasePackage."freeOfferCount" — NOT NULL DEFAULT 3, CHECK 1..50. The
--     number of free offers one run bought with the package carries. Every
--     existing package reads 3, the fixed figure CAMPAIGN-ENTITLEMENT-001
--     granted every run.
--   * PackagePurchase."freeOfferCountSnapshot" — nullable; NULL on every
--     OFFER_PACKAGE row (CHECK), the number shown to the buyer on a
--     SHOWCASE_PACKAGE row. Backfilled to 3 for every existing vitrin purchase.
--   * ShowcaseEntitlement."freeOfferCountSnapshot" and
--     ShowcasePlacement."freeOfferCountSnapshot" — NOT NULL DEFAULT 3, CHECK
--     >= 1. The default is the backfill (a constant default is a catalog-only
--     change in PostgreSQL, no table rewrite).
--
-- The snapshot chain is package → purchase (checkout) → entitlement / placement
-- → OfferAllowanceGrant."quotaTotal" (birth). Editing a package therefore never
-- reaches a right, a run or a grant already sold. Existing grants are not
-- touched: their "quotaTotal" (legacy count + 3) stays exactly as it is.
--
-- Additive: an application version predating this migration keeps working
-- (it never reads the new columns, and its writes take the defaults / NULL,
-- which settlement reads as the legacy 3). Deploy order: migrate → api → web →
-- admin. Rollback: drop the four columns and their CHECKs (no data is lost
-- that a pre-migration version would have read).

-- AlterTable
ALTER TABLE "ShowcasePackage" ADD COLUMN "freeOfferCount" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "PackagePurchase" ADD COLUMN "freeOfferCountSnapshot" INTEGER;

-- AlterTable
ALTER TABLE "ShowcaseEntitlement" ADD COLUMN "freeOfferCountSnapshot" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "ShowcasePlacement" ADD COLUMN "freeOfferCountSnapshot" INTEGER NOT NULL DEFAULT 3;

-- BEGIN BACKFILL
UPDATE "PackagePurchase"
   SET "freeOfferCountSnapshot" = 3
 WHERE "kind" = 'SHOWCASE_PACKAGE'
   AND "freeOfferCountSnapshot" IS NULL;
-- END BACKFILL

ALTER TABLE "ShowcasePackage"
  ADD CONSTRAINT "ShowcasePackage_free_offer_count_range"
  CHECK ("freeOfferCount" BETWEEN 1 AND 50);

ALTER TABLE "PackagePurchase"
  ADD CONSTRAINT "PackagePurchase_free_offer_count_snapshot_shape"
  CHECK (
    "freeOfferCountSnapshot" IS NULL
    OR ("kind" = 'SHOWCASE_PACKAGE' AND "freeOfferCountSnapshot" >= 1)
  );

ALTER TABLE "ShowcaseEntitlement"
  ADD CONSTRAINT "ShowcaseEntitlement_free_offer_count_snapshot_positive"
  CHECK ("freeOfferCountSnapshot" >= 1);

ALTER TABLE "ShowcasePlacement"
  ADD CONSTRAINT "ShowcasePlacement_free_offer_count_snapshot_positive"
  CHECK ("freeOfferCountSnapshot" >= 1);

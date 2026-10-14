-- SHOWCASE-ALLOWANCE-003: a vitrin package may carry no free offers at all.
--
-- `ShowcasePackage."freeOfferCount"` goes from 1..50 to 0..50, and the three
-- snapshots that copy it along the sale (purchase → right / run) accept 0 too.
-- 0 means the run sold with the package carries no free offer: no
-- OfferAllowanceGrant is born for it (the grant's own CHECK "quotaTotal" > 0 is
-- deliberately left as it is), and every offer on its leads is paid through
-- the normal entitlement / credit path.
--
-- Constraint-only: no row is written, no default changes (still 3), and every
-- existing row already satisfies the wider ranges. Purchases, rights, runs,
-- grants and usages sold before this migration are untouched.
--
-- Additive for the application: a version predating this migration never
-- writes 0. Rollback (only while no row holds 0): re-add the four CHECKs (the two snapshot ones under their old names) with
-- their 20261016090000 lower bound of 1.

ALTER TABLE "ShowcasePackage"
  DROP CONSTRAINT "ShowcasePackage_free_offer_count_range",
  ADD CONSTRAINT "ShowcasePackage_free_offer_count_range"
  CHECK ("freeOfferCount" BETWEEN 0 AND 50);

ALTER TABLE "PackagePurchase"
  DROP CONSTRAINT "PackagePurchase_free_offer_count_snapshot_shape",
  ADD CONSTRAINT "PackagePurchase_free_offer_count_snapshot_shape"
  CHECK (
    "freeOfferCountSnapshot" IS NULL
    OR ("kind" = 'SHOWCASE_PACKAGE' AND "freeOfferCountSnapshot" >= 0)
  );

ALTER TABLE "ShowcaseEntitlement"
  DROP CONSTRAINT "ShowcaseEntitlement_free_offer_count_snapshot_positive",
  ADD CONSTRAINT "ShowcaseEntitlement_free_offer_count_snapshot_non_negative"
  CHECK ("freeOfferCountSnapshot" >= 0);

ALTER TABLE "ShowcasePlacement"
  DROP CONSTRAINT "ShowcasePlacement_free_offer_count_snapshot_positive",
  ADD CONSTRAINT "ShowcasePlacement_free_offer_count_snapshot_non_negative"
  CHECK ("freeOfferCountSnapshot" >= 0);

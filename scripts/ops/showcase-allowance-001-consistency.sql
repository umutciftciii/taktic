-- SHOWCASE-ALLOWANCE-001: free offer count snapshot consistency — read-only, one statement.
--
-- Returns one row per violation and nothing when the data is consistent:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/showcase-allowance-001-consistency.sql
--
-- The API integration tests run this exact file (apps/api/test/
-- showcase-package-free-offers.spec.ts), so it must stay a single SELECT with
-- no psql meta-commands. Needs migration 20261016090000.
--
-- The snapshot chain is package → purchase (checkout) → entitlement / placement
-- → OfferAllowanceGrant."quotaTotal" (birth). A NULL purchase snapshot is the
-- legacy 3 (a checkout an older application version opened).
--
-- Checks:
--   1 ENTITLEMENT_SNAPSHOT_MISMATCH   a right's count is not its purchase's
--   2 PLACEMENT_PURCHASE_MISMATCH     a card-bound run's count is not its purchase's
--   3 PLACEMENT_ENTITLEMENT_MISMATCH  a package-first run's count is not its right's
--   4 GRANT_QUOTA_MISMATCH            a grant born by the application (not the 101
--                                     backfill, whose ids are 'oag_<placementId>')
--                                     does not carry its run's count
--   5 GRANT_QUOTA_BELOW_SNAPSHOT      any grant carries fewer slots than its run was sold
--   6 OFFER_PACKAGE_WITH_SNAPSHOT     a credit package purchase carries a free offer count
SELECT 'ENTITLEMENT_SNAPSHOT_MISMATCH' AS "check", e."id" AS "subject"
  FROM "ShowcaseEntitlement" e
  JOIN "PackagePurchase" pp ON pp."id" = e."purchaseId"
 WHERE e."freeOfferCountSnapshot" <> coalesce(pp."freeOfferCountSnapshot", 3)
UNION ALL
SELECT 'PLACEMENT_PURCHASE_MISMATCH', p."id"
  FROM "ShowcasePlacement" p
  JOIN "PackagePurchase" pp ON pp."id" = p."purchaseId"
 WHERE pp."showcaseCardId" IS NOT NULL
   AND p."freeOfferCountSnapshot" <> coalesce(pp."freeOfferCountSnapshot", 3)
UNION ALL
SELECT 'PLACEMENT_ENTITLEMENT_MISMATCH', p."id"
  FROM "ShowcasePlacement" p
  JOIN "ShowcaseEntitlement" e ON e."placementId" = p."id"
 WHERE p."freeOfferCountSnapshot" <> e."freeOfferCountSnapshot"
UNION ALL
SELECT 'GRANT_QUOTA_MISMATCH', g."id"
  FROM "OfferAllowanceGrant" g
  JOIN "ShowcasePlacement" p ON p."id" = g."showcasePlacementId"
 WHERE g."id" NOT LIKE 'oag\_%'
   AND g."quotaTotal" <> p."freeOfferCountSnapshot"
UNION ALL
SELECT 'GRANT_QUOTA_BELOW_SNAPSHOT', g."id"
  FROM "OfferAllowanceGrant" g
  JOIN "ShowcasePlacement" p ON p."id" = g."showcasePlacementId"
 WHERE g."quotaTotal" < p."freeOfferCountSnapshot"
UNION ALL
SELECT 'OFFER_PACKAGE_WITH_SNAPSHOT', pp."id"
  FROM "PackagePurchase" pp
 WHERE pp."kind" = 'OFFER_PACKAGE'
   AND pp."freeOfferCountSnapshot" IS NOT NULL;

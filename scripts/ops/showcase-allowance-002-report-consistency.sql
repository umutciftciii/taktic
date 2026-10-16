-- SHOWCASE-ALLOWANCE-002: free vitrin offer finance report — read-only, one statement.
--
-- Returns one row per fact the report (GET /finance/offer-allowances) would
-- read wrongly or silently leave out, and nothing when the data is consistent:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/showcase-allowance-002-report-consistency.sql
--
-- The API integration tests run this exact file after every report case
-- (apps/api/test/finance-offer-allowance-report.spec.ts), so it must stay a
-- single SELECT with no psql meta-commands. Needs migration 103.
--
-- It complements, never replaces, campaign-entitlement-001-consistency.sql and
-- showcase-allowance-001-consistency.sql (slot accounting itself).
--
-- Checks:
--   1 LEGACY_ON_NEW_GRANT         a grant born after the rollout (not a backfilled 'oag_'
--                                 grant) counts a used slot with no usage row: the report
--                                 would show it as legacy, with no credit and no TL value
--   2 GRANT_WITHOUT_PLACEMENT     a grant the report cannot place (it joins the placement
--                                 for package and category, so the grant would be dropped)
--   3 GRANT_QUOTA_NOT_SNAPSHOT    a grant born after the rollout (not a backfilled
--                                 'oag_' grant) whose quota is not its placement's
--                                 freeOfferCountSnapshot
--   4 USAGE_BEFORE_RUN_START      a slot spent before its run started (usage outside the
--                                 grant's own window would split the two clocks)
--   5 USAGE_CATEGORY_NOT_REQUEST  a usage row's category is not its request's category
--                                 (the category breakdown would credit the wrong row)
--   6 UNPLACED_STATE_MISMATCH     a vitrin right whose placement link disagrees with its
--                                 status (CONSUMED without a placement, or
--                                 AVAILABLE / RESERVED / EXPIRED with one)
--   7 RATE_PURCHASE_UNDATED       a PAID credit package purchase with credits but no
--                                 paidAt: it can never enter a month's TL rate
--   8 RATE_PURCHASE_NOT_TRY       a PAID credit package purchase in another currency:
--                                 left out of the TL rate by design, listed for review
SELECT 'LEGACY_ON_NEW_GRANT' AS "check", g."id" AS "subject"
  FROM "OfferAllowanceGrant" g
 WHERE g."id" NOT LIKE 'oag\_%'
   AND g."quotaUsed" > (SELECT count(*) FROM "OfferAllowanceUsage" u WHERE u."grantId" = g."id")
UNION ALL
SELECT 'GRANT_WITHOUT_PLACEMENT', g."id"
  FROM "OfferAllowanceGrant" g
 WHERE g."showcasePlacementId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "ShowcasePlacement" p WHERE p."id" = g."showcasePlacementId")
UNION ALL
SELECT 'GRANT_QUOTA_NOT_SNAPSHOT', g."id"
  FROM "OfferAllowanceGrant" g
  JOIN "ShowcasePlacement" p ON p."id" = g."showcasePlacementId"
 WHERE g."id" NOT LIKE 'oag\_%'
   AND g."quotaTotal" <> p."freeOfferCountSnapshot"
UNION ALL
SELECT 'USAGE_BEFORE_RUN_START', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "OfferAllowanceGrant" g ON g."id" = u."grantId"
 WHERE u."consumedAt" < g."validFrom"
UNION ALL
SELECT 'USAGE_CATEGORY_NOT_REQUEST', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "ServiceRequest" r ON r."id" = u."requestId"
 WHERE r."categoryId" <> u."categoryId"
UNION ALL
SELECT 'UNPLACED_STATE_MISMATCH', e."id"
  FROM "ShowcaseEntitlement" e
 WHERE (e."status" = 'CONSUMED' AND e."placementId" IS NULL)
    OR (e."status" IN ('AVAILABLE', 'RESERVED', 'EXPIRED') AND e."placementId" IS NOT NULL)
UNION ALL
SELECT 'RATE_PURCHASE_UNDATED', pp."id"
  FROM "PackagePurchase" pp
 WHERE pp."kind" = 'OFFER_PACKAGE'
   AND pp."status" = 'PAID'
   AND pp."creditAmountSnapshot" > 0
   AND pp."paidAt" IS NULL
UNION ALL
SELECT 'RATE_PURCHASE_NOT_TRY', pp."id"
  FROM "PackagePurchase" pp
 WHERE pp."kind" = 'OFFER_PACKAGE'
   AND pp."status" = 'PAID'
   AND pp."creditAmountSnapshot" > 0
   AND pp."currencySnapshot" <> 'TRY';

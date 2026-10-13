-- CAMPAIGN-ENTITLEMENT-001: offer allowance consistency — read-only, one statement.
--
-- Returns one row per violation and nothing when the data is consistent:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/campaign-entitlement-001-consistency.sql
--
-- The API integration tests run this exact file after every allowance case
-- (apps/api/test/offer-allowance.spec.ts), so it must stay a single SELECT
-- with no psql meta-commands. Needs migration 101.
--
-- Checks:
--   1 GRANT_USED_BELOW_USAGES      a grant counts fewer used slots than it has usage rows
--   2 USAGE_BEYOND_CLAIMED         a usage ordinal above the grant's quotaUsed
--   3 USAGE_PROVIDER_MISMATCH      a usage row's provider is not its grant's
--   4 USAGE_OFFER_NOT_FREE         a slot paid for an offer that records a cost, a
--                                  non-vitrin source or a spend transaction
--   5 USAGE_OFFER_MISMATCH         usage and offer disagree on provider, request or round
--   6 USAGE_CROSS_PLACEMENT        the usage's lead came through another placement
--   7 USAGE_OFFER_HAS_LEDGER       an OFFER_SPEND ledger row exists for a free allowance offer
--   8 LIVE_PLACEMENT_WITHOUT_GRANT a running (or suspended) placement has no grant
--   9 LEDGER_CHAIN_BREAK           a provider's credit ledger running balance does not
--                                  follow from the previous row (no balance drift)
SELECT 'GRANT_USED_BELOW_USAGES' AS "check", g."id" AS "subject"
  FROM "OfferAllowanceGrant" g
 WHERE g."quotaUsed" < (SELECT count(*) FROM "OfferAllowanceUsage" u WHERE u."grantId" = g."id")
UNION ALL
SELECT 'USAGE_BEYOND_CLAIMED', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "OfferAllowanceGrant" g ON g."id" = u."grantId"
 WHERE u."ordinal" > g."quotaUsed"
UNION ALL
SELECT 'USAGE_PROVIDER_MISMATCH', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "OfferAllowanceGrant" g ON g."id" = u."grantId"
 WHERE u."providerId" <> g."providerId"
UNION ALL
SELECT 'USAGE_OFFER_NOT_FREE', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "Offer" o ON o."id" = u."offerId"
 WHERE o."creditCost" <> 0
    OR o."entitlementSource" IS DISTINCT FROM 'SHOWCASE_PLACEMENT'
    OR o."creditSpentTransactionId" IS NOT NULL
UNION ALL
SELECT 'USAGE_OFFER_MISMATCH', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "Offer" o ON o."id" = u."offerId"
 WHERE o."providerId" <> u."providerId"
    OR o."requestId" <> u."requestId"
    OR o."matchRoundId" <> u."matchRoundId"
UNION ALL
SELECT 'USAGE_CROSS_PLACEMENT', u."id"
  FROM "OfferAllowanceUsage" u
  JOIN "OfferAllowanceGrant" g ON g."id" = u."grantId"
  JOIN "ShowcaseLead" l ON l."id" = u."showcaseLeadId"
 WHERE g."showcasePlacementId" IS DISTINCT FROM l."placementId"
UNION ALL
SELECT 'USAGE_OFFER_HAS_LEDGER', u."id"
  FROM "OfferAllowanceUsage" u
 WHERE EXISTS (
   SELECT 1 FROM "ProviderCreditTransaction" t
    WHERE t."type" = 'OFFER_SPEND'
      AND t."referenceType" = 'Offer'
      AND t."referenceId" = u."offerId"
 )
UNION ALL
SELECT 'LIVE_PLACEMENT_WITHOUT_GRANT', p."id"
  FROM "ShowcasePlacement" p
 WHERE ((p."status" IN ('PENDING_ACTIVATION', 'ACTIVE') AND p."endAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
        OR p."status" = 'SUSPENDED')
   AND NOT EXISTS (SELECT 1 FROM "OfferAllowanceGrant" g WHERE g."showcasePlacementId" = p."id")
UNION ALL
SELECT 'LEDGER_CHAIN_BREAK', chain."id"
  FROM (
    SELECT t."id",
           t."amount",
           t."balanceAfter",
           lag(t."balanceAfter") OVER (PARTITION BY t."providerId" ORDER BY t."createdAt", t."id") AS "previous"
      FROM "ProviderCreditTransaction" t
  ) chain
 WHERE chain."balanceAfter" <> coalesce(chain."previous", 0) + chain."amount";

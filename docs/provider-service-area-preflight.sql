-- Preflight for the add_provider_service_area_scope migration.
--
-- Read-only. Run it against the target database *before* deploying, so the four
-- things that would stop the migration are known in advance rather than found
-- during a release window. The migration asks these same questions and refuses
-- to change anything if any of them has an answer — it never edits or deletes a
-- row to make itself pass.
--
--   psql "$DATABASE_URL" -f docs/provider-service-area-preflight.sql
--
-- Every section that returns no rows is a section that will not stop the
-- migration. A section that returns rows is a decision for a person: which of
-- two duplicate rows to keep, what a neighbourhood with no district was meant
-- to say, which place a blank level should have named.
--
-- The last section is informational, not a blocker: it lists the providers the
-- migration will give a service area to, copied from their legacy single
-- location. Reading it before the deploy is how the count is verified after it.

\echo '== 1. Duplicate areas (BLOCKS: the per-scope unique indexes cannot be created) =='
SELECT
  "providerId",
  "city",
  coalesce("district", '(whole province)') AS district,
  coalesce("neighborhood", '(whole district)') AS neighborhood,
  count(*) AS rows,
  string_agg("id", ', ' ORDER BY "createdAt", "id") AS area_ids
FROM "ProviderServiceArea"
GROUP BY "providerId", "city", "district", "neighborhood"
HAVING count(*) > 1
ORDER BY "providerId";

\echo '== 2. Neighbourhoods with no district (BLOCKS: they name no place and fit no scope) =='
SELECT "id", "providerId", "city", "neighborhood", "createdAt"
FROM "ProviderServiceArea"
WHERE "district" IS NULL AND "neighborhood" IS NOT NULL
ORDER BY "providerId";

\echo '== 3. Blank levels (BLOCKS: they satisfy every constraint and match nothing) =='
SELECT "id", "providerId", "city", "district", "neighborhood", "createdAt"
FROM "ProviderServiceArea"
WHERE btrim("city") = ''
   OR ("district" IS NOT NULL AND btrim("district") = '')
   OR ("neighborhood" IS NOT NULL AND btrim("neighborhood") = '')
ORDER BY "providerId";

\echo '== 4. Providers with no area and no usable legacy location (BLOCKS: nothing to backfill from) =='
SELECT "p"."id", "p"."businessName", "p"."city", "p"."district", "p"."status"
FROM "ProviderProfile" AS "p"
WHERE NOT EXISTS (SELECT 1 FROM "ProviderServiceArea" AS "a" WHERE "a"."providerId" = "p"."id")
  AND (btrim("p"."city") = '' OR btrim("p"."district") = '')
ORDER BY "p"."id";

\echo '== 5. Providers the migration will backfill one area for (informational) =='
SELECT "p"."id", "p"."businessName", "p"."city", "p"."district", "p"."status"
FROM "ProviderProfile" AS "p"
WHERE NOT EXISTS (SELECT 1 FROM "ProviderServiceArea" AS "a" WHERE "a"."providerId" = "p"."id")
  AND btrim("p"."city") <> ''
  AND btrim("p"."district") <> ''
ORDER BY "p"."id";

\echo '== 6. Counts to compare before and after (informational) =='
SELECT 'providers' AS metric, count(*) AS value FROM "ProviderProfile"
UNION ALL SELECT 'service_areas', count(*) FROM "ProviderServiceArea"
UNION ALL SELECT 'providers_with_zero_areas', count(*) FROM "ProviderProfile" p
  WHERE NOT EXISTS (SELECT 1 FROM "ProviderServiceArea" a WHERE a."providerId" = p."id")
UNION ALL SELECT 'provider_category_bindings', count(*) FROM "ProviderServiceCategory"
UNION ALL SELECT 'service_requests', count(*) FROM "ServiceRequest"
UNION ALL SELECT 'offers', count(*) FROM "Offer"
ORDER BY 1;

-- Not a blocker, and deliberately so: a provider holding both "İstanbul geneli"
-- and "İstanbul/Kadıköy" keeps both rows. The pair is redundant, not
-- contradictory, and nothing about matching changes — the API refuses a *new*
-- area that overlaps, and the provider's own screen shows both with a remove
-- button beside each, so it is their call and not a migration's.
\echo '== 7. Overlapping areas that will be kept as they are (informational) =='
SELECT
  "narrow"."providerId",
  "wide"."id" AS wider_area_id,
  "wide"."city" AS wider_city,
  coalesce("wide"."district", '(whole province)') AS wider_district,
  "narrow"."id" AS covered_area_id,
  "narrow"."city" AS covered_city,
  "narrow"."district" AS covered_district,
  "narrow"."neighborhood" AS covered_neighborhood
FROM "ProviderServiceArea" AS "narrow"
JOIN "ProviderServiceArea" AS "wide"
  ON "wide"."providerId" = "narrow"."providerId"
 AND "wide"."id" <> "narrow"."id"
 AND "wide"."city" = "narrow"."city"
 AND ("wide"."district" IS NULL OR "wide"."district" = "narrow"."district")
 AND ("wide"."neighborhood" IS NULL OR "wide"."neighborhood" = "narrow"."neighborhood")
 AND (
   "wide"."district" IS NULL AND "narrow"."district" IS NOT NULL
   OR "wide"."neighborhood" IS NULL AND "narrow"."neighborhood" IS NOT NULL
 )
ORDER BY "narrow"."providerId";

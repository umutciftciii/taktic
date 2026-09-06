-- Multiple service areas per provider, at three explicit scopes.
--
-- The table already held many rows per provider and already read a NULL
-- district as "the whole province". What it did not have was a way to say so,
-- and so no way for the database to stop a duplicate: PostgreSQL treats NULLs
-- as distinct in a unique index, so the old
-- UNIQUE (providerId, city, district, neighborhood) admitted "all of İstanbul"
-- twice, and "İstanbul/Kadıköy" twice, and only ever bound the one scope that
-- leaves no column NULL.
--
-- Nothing here rewrites or recreates a surviving row. Every existing area keeps
-- its id, its timestamps and the place it names; the scope is read off the
-- levels that are already there.

-- CreateEnum
CREATE TYPE "ProviderServiceAreaScope" AS ENUM ('CITY', 'DISTRICT', 'NEIGHBORHOOD');

-- AlterTable: nullable first, so the backfill below has something to fill.
ALTER TABLE "ProviderServiceArea" ADD COLUMN "scope" "ProviderServiceAreaScope";

-- Backfill 1 of 2: the scope every existing row already had, unwritten.
UPDATE "ProviderServiceArea"
SET "scope" = CASE
  WHEN "district" IS NULL THEN 'CITY'::"ProviderServiceAreaScope"
  WHEN "neighborhood" IS NULL THEN 'DISTRICT'::"ProviderServiceAreaScope"
  ELSE 'NEIGHBORHOOD'::"ProviderServiceAreaScope"
END;

-- A neighbourhood floating under a whole province names no place, and the CHECK
-- added at the end refuses it. The API has refused one since service areas were
-- validated against the canonical location list, so this is expected to touch
-- nothing; it exists so the constraint cannot fail on a row written before that.
UPDATE "ProviderServiceArea"
SET "neighborhood" = NULL
WHERE "district" IS NULL AND "neighborhood" IS NOT NULL;

-- Backfill 2 of 2: a provider with no area at all gets one, at the business
-- address, so "at least one service area" holds for every existing row and not
-- only for applications filed through the API. This is the migration that makes
-- ProviderServiceArea the single source of coverage: after it, no provider
-- depends on ProviderProfile.city/district being read as an implicit area.
INSERT INTO "ProviderServiceArea" ("id", "providerId", "scope", "city", "district", "neighborhood", "createdAt", "updatedAt")
SELECT
  'psa_bf_' || "p"."id",
  "p"."id",
  'DISTRICT'::"ProviderServiceAreaScope",
  "p"."city",
  "p"."district",
  NULL,
  "p"."createdAt",
  CURRENT_TIMESTAMP
FROM "ProviderProfile" AS "p"
WHERE NOT EXISTS (
  SELECT 1 FROM "ProviderServiceArea" AS "a" WHERE "a"."providerId" = "p"."id"
);

-- Duplicates that the old index let through, collapsed onto the oldest row.
-- Two rows naming the same area at the same scope are the same coverage written
-- twice: dropping the later one removes no reach from any provider, and it is
-- the only way the unique indexes below can be created at all.
DELETE FROM "ProviderServiceArea" AS "a"
USING "ProviderServiceArea" AS "keep"
WHERE "a"."providerId" = "keep"."providerId"
  AND "a"."scope" = "keep"."scope"
  AND "a"."city" = "keep"."city"
  AND "a"."district" IS NOT DISTINCT FROM "keep"."district"
  AND "a"."neighborhood" IS NOT DISTINCT FROM "keep"."neighborhood"
  AND ("keep"."createdAt", "keep"."id") < ("a"."createdAt", "a"."id");

-- Areas a wider area of the same provider already reaches, collapsed onto the
-- wider one. "İstanbul geneli" beside "İstanbul/Kadıköy" is not wider coverage
-- than "İstanbul geneli" alone; the narrow row adds nothing a request could
-- match on, and it is exactly what the API refuses on every save from now on.
-- Leaving them would strand those providers on a profile they cannot save
-- without first working out which of their own rows to delete.
--
-- No reach is lost: every deleted row's places are still covered by the row
-- that swallowed it, which is the condition of the delete.
DELETE FROM "ProviderServiceArea" AS "a"
USING "ProviderServiceArea" AS "wider"
WHERE "a"."providerId" = "wider"."providerId"
  AND "a"."id" <> "wider"."id"
  AND "wider"."city" = "a"."city"
  AND ("wider"."district" IS NULL OR "wider"."district" = "a"."district")
  AND ("wider"."neighborhood" IS NULL OR "wider"."neighborhood" = "a"."neighborhood")
  AND "wider"."scope" < "a"."scope";

-- AlterTable
ALTER TABLE "ProviderServiceArea" ALTER COLUMN "scope" SET NOT NULL;

-- DropIndex: superseded by the three partial indexes below. It bound one scope
-- of three and is the reason the other two were never bound at all.
DROP INDEX IF EXISTS "ProviderServiceArea_providerId_city_district_neighborhood_key";

-- The scope may not disagree with the levels it names. Without this the column
-- is a comment: a writer could store a CITY row that names a district, and the
-- CITY index would then hold one row per province while the row itself covered
-- something narrower.
ALTER TABLE "ProviderServiceArea"
  ADD CONSTRAINT "ProviderServiceArea_scope_levels" CHECK (
    ("scope" = 'CITY' AND "district" IS NULL AND "neighborhood" IS NULL)
    OR ("scope" = 'DISTRICT' AND "district" IS NOT NULL AND "neighborhood" IS NULL)
    OR ("scope" = 'NEIGHBORHOOD' AND "district" IS NOT NULL AND "neighborhood" IS NOT NULL)
  );

-- One row per area, per scope. Partial, because each scope keys on a different
-- set of columns and the columns the narrower scopes use are NULL in the wider
-- ones — which is exactly what a plain unique index cannot handle.
CREATE UNIQUE INDEX "ProviderServiceArea_one_city_area"
  ON "ProviderServiceArea" ("providerId", "city")
  WHERE "scope" = 'CITY';

CREATE UNIQUE INDEX "ProviderServiceArea_one_district_area"
  ON "ProviderServiceArea" ("providerId", "city", "district")
  WHERE "scope" = 'DISTRICT';

CREATE UNIQUE INDEX "ProviderServiceArea_one_neighborhood_area"
  ON "ProviderServiceArea" ("providerId", "city", "district", "neighborhood")
  WHERE "scope" = 'NEIGHBORHOOD';

-- CreateIndex: the lookup every read of this table performs — "the areas of
-- this provider" — which the dropped unique index used to serve as its prefix.
CREATE INDEX "ProviderServiceArea_providerId_idx" ON "ProviderServiceArea"("providerId");

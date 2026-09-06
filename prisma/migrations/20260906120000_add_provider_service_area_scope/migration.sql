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
-- This migration adds and never subtracts. It deletes no row, merges no row and
-- rewrites no row's place: every existing area keeps its id, its providerId,
-- its city/district/neighborhood and therefore exactly the reach it had. The
-- only INSERT is for a provider that had no area at all.
--
-- Where the stored data cannot satisfy the new constraints, the migration stops
-- with an error naming what it found rather than editing the data into shape.
-- Prisma runs a migration file in one transaction, so a stop leaves the
-- database exactly as it was — nothing half-applied, nothing quietly deleted,
-- and an operator with a list of rows to look at.
-- `docs/provider-service-area-preflight.sql` asks the same four questions
-- read-only, so the answer is known before a deploy rather than during one.

-- ────────────────────────────────────────────────────────────────────────────
-- Guards. All four run before anything is altered.
-- ────────────────────────────────────────────────────────────────────────────

-- Two rows naming the same area for one provider. The partial unique indexes at
-- the end cannot be created over them, and which of the two to drop is not this
-- migration's call to make: they may carry different createdAt values that an
-- operator is entitled to look at first.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s (%s/%s/%s) x%s', "providerId",
                           "city", coalesce("district", '*'), coalesce("neighborhood", '*'), n),
                    ', ')
  INTO offenders
  FROM (
    SELECT "providerId", "city", "district", "neighborhood", count(*) AS n
    FROM "ProviderServiceArea"
    GROUP BY "providerId", "city", "district", "neighborhood"
    HAVING count(*) > 1
  ) AS duplicates;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'ProviderServiceArea holds duplicate areas, which the new per-scope unique indexes cannot be created over: %. Remove the redundant rows deliberately, then re-run this migration. Nothing has been changed.',
      offenders;
  END IF;
END $$;

-- A neighbourhood under no district names no place: there is no scope it can be
-- given, and the CHECK at the end would refuse it. Nulling the neighbourhood
-- would widen that row's reach without anybody asking, and deleting it would
-- take reach away — so neither.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg("id", ', ')
  INTO offenders
  FROM "ProviderServiceArea"
  WHERE "district" IS NULL AND "neighborhood" IS NOT NULL;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'ProviderServiceArea holds neighbourhoods with no district, which name no place and fit no scope: %. Decide what each one meant, fix it deliberately, then re-run this migration. Nothing has been changed.',
      offenders;
  END IF;
END $$;

-- A blank level is the same problem wearing a different shape: it passes every
-- constraint below and matches nothing, forever, with nothing on screen to say
-- why. Left for a person to resolve, like the two above.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg("id", ', ')
  INTO offenders
  FROM "ProviderServiceArea"
  WHERE btrim("city") = ''
     OR ("district" IS NOT NULL AND btrim("district") = '')
     OR ("neighborhood" IS NOT NULL AND btrim("neighborhood") = '');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'ProviderServiceArea holds areas with a blank city, district or neighbourhood: %. Fix them deliberately, then re-run this migration. Nothing has been changed.',
      offenders;
  END IF;
END $$;

-- The backfill below reads a provider's legacy single location. A provider with
-- no area at all and no usable legacy pair cannot be given one, and inventing a
-- place for them would be worse than stopping.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg("p"."id", ', ')
  INTO offenders
  FROM "ProviderProfile" AS "p"
  WHERE NOT EXISTS (SELECT 1 FROM "ProviderServiceArea" AS "a" WHERE "a"."providerId" = "p"."id")
    AND (btrim("p"."city") = '' OR btrim("p"."district") = '');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'These providers have no service area and no usable legacy location to derive one from: %. Give them an area deliberately, then re-run this migration. Nothing has been changed.',
      offenders;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- The change.
-- ────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ProviderServiceAreaScope" AS ENUM ('CITY', 'DISTRICT', 'NEIGHBORHOOD');

-- AlterTable: nullable first, so the backfill below has something to fill.
ALTER TABLE "ProviderServiceArea" ADD COLUMN "scope" "ProviderServiceAreaScope";

-- The scope every existing row already had, unwritten. Read off the levels that
-- are already there, so no row's meaning changes: this records what the row
-- said, it does not decide it.
UPDATE "ProviderServiceArea"
SET "scope" = CASE
  WHEN "district" IS NULL THEN 'CITY'::"ProviderServiceAreaScope"
  WHEN "neighborhood" IS NULL THEN 'DISTRICT'::"ProviderServiceAreaScope"
  ELSE 'NEIGHBORHOOD'::"ProviderServiceAreaScope"
END;

-- The one INSERT. A provider with no area row at all has been matched all along
-- on its legacy single location, so that location is copied into the coverage
-- table and becomes the row matching reads. A provider that already has one or
-- more areas is left exactly alone: its legacy pair is history, not a fourth
-- area nobody asked for.
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
--
-- These bind duplicates and nothing else. A provider holding both "İstanbul
-- geneli" and "İstanbul/Kadıköy" keeps both: the pair is redundant, not
-- contradictory, and it is the API that stops a *new* one being added — see
-- assertNewAreasAreDistinctAndUncovered, which grandfathers a pair already
-- stored so an untouched profile still saves.
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

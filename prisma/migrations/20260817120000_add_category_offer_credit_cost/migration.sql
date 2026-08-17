-- Category-based offer pricing.
--
-- One additive migration performs all three steps so there is never a window in
-- which the schema exists but prices do not: adding the column, constraining it,
-- and seeding the approved starting prices happen in a single transaction.
--
-- Deliberately NO column default: a default would be the hidden "1 credit"
-- fallback the pricing rules forbid. NULL means "price not set" and blocks
-- offering.

-- 1) Column
ALTER TABLE "ServiceCategory" ADD COLUMN "offerCreditCost" INTEGER;

-- 2) Constraint: a price is either unset (NULL) or strictly positive.
--    This makes 0 and negative costs unrepresentable even if application-level
--    validation is bypassed.
ALTER TABLE "ServiceCategory"
  ADD CONSTRAINT "ServiceCategory_offerCreditCost_positive"
  CHECK ("offerCreditCost" IS NULL OR "offerCreditCost" > 0);

-- 3) Backfill the approved starting prices.
--    Matched by slug (unique and environment-stable; ids are not).
--    `AND "offerCreditCost" IS NULL` keeps this idempotent and stops the
--    migration from overwriting a price someone has already set.
UPDATE "ServiceCategory" SET "offerCreditCost" = 4 WHERE "slug" = 'klima-montaji'  AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 4 WHERE "slug" = 'boya-badana'    AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 3 WHERE "slug" = 'kombi-servisi'  AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 2 WHERE "slug" = 'klima-servisi'  AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 2 WHERE "slug" = 'elektrikci'     AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 2 WHERE "slug" = 'su-tesisatcisi' AND "offerCreditCost" IS NULL;
UPDATE "ServiceCategory" SET "offerCreditCost" = 1 WHERE "slug" = 'ev-temizligi'   AND "offerCreditCost" IS NULL;

-- 4) Fail loudly rather than silently leaving an active category unpriced.
--
--    A slug that does not exist makes its UPDATE a no-op, which on its own is
--    silent. This guard turns that silence into a failed migration: if any
--    ACTIVE category still has no price, the whole migration rolls back and the
--    operator has to price it explicitly. Inactive categories are exempt —
--    they cannot receive requests, so an unpriced archived category is fine.
DO $$
DECLARE
  unpriced TEXT;
BEGIN
  SELECT string_agg("slug", ', ' ORDER BY "slug")
    INTO unpriced
    FROM "ServiceCategory"
   WHERE "isActive" = true
     AND "offerCreditCost" IS NULL;

  IF unpriced IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration aborted: active categories without an offer credit cost: %. Add an explicit price for them before migrating.',
      unpriced;
  END IF;
END $$;

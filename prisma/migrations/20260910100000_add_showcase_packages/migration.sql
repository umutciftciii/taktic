-- Vitrin phase two, step 1 of 7: the catalogue an operator sells from.
--
-- Purely additive. One new enum type, one new table, and one CHECK added to an
-- existing table that no existing row can fail. Nothing is read, rewritten or
-- deleted; no column changes type or nullability.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why a separate catalogue rather than a fourth OfferPackageType
-- ────────────────────────────────────────────────────────────────────────────
--
-- `OfferCreditPackage` already carries CHECK constraints pairing its three
-- product types with their nullable columns, and adding a fourth would mean
-- loosening guarantees the existing three depend on. Worse, `OfferPackageType`
-- is read on the offer hot path by the entitlement resolver: a vitrin package
-- is never an offering right, and a single missed `switch` branch there would
-- be a vitrin purchase quietly granting offer capacity.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why the two slug CHECKs
-- ────────────────────────────────────────────────────────────────────────────
--
-- LEMON_SQUEEZY_VARIANT_MAP is keyed by package slug and spans both catalogues.
-- Without a rule keeping the two namespaces apart, one map entry could serve a
-- credit package and a vitrin package at the same time, and no database
-- constraint would ever see it. The prefix rule makes that collision
-- unrepresentable from both sides: a vitrin package's slug must begin with
-- `vitrin-`, and an offer package's must not.
--
-- The second CHECK is validated against every existing row. It was verified
-- before this migration was written that no `OfferCreditPackage` slug begins
-- with `vitrin-` (the shipped three are `starter-20`, `pro-50`,
-- `business-100`). If a deployment has one, this migration fails loudly rather
-- than silently admitting the collision — and renaming it is an operator
-- decision, because the slug is also the key into the variant map in `.env`.

-- CreateEnum
CREATE TYPE "PackagePurchaseKind" AS ENUM ('OFFER_PACKAGE', 'SHOWCASE_PACKAGE');

-- CreateTable
CREATE TABLE "ShowcasePackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "priceAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "durationDays" INTEGER NOT NULL,
    "allowedCardKind" "ShowcaseCardKind",
    "maxAreas" INTEGER,
    "requiresAdminApproval" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcasePackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcasePackage_slug_key" ON "ShowcasePackage"("slug");

-- CreateIndex
CREATE INDEX "ShowcasePackage_isActive_sortOrder_idx" ON "ShowcasePackage"("isActive", "sortOrder");

-- The catalogue's own bounds, in the database as well as in the DTO. A package
-- priced at zero is a free placement nobody decided to give away, and a
-- duration outside these bounds is a typo rather than a product.
ALTER TABLE "ShowcasePackage"
  ADD CONSTRAINT "ShowcasePackage_slug_prefix" CHECK ("slug" LIKE 'vitrin-%'),
  ADD CONSTRAINT "ShowcasePackage_currency_try" CHECK ("currency" = 'TRY'),
  ADD CONSTRAINT "ShowcasePackage_price_positive" CHECK ("priceAmount" > 0),
  ADD CONSTRAINT "ShowcasePackage_duration_bounds" CHECK ("durationDays" BETWEEN 1 AND 365),
  ADD CONSTRAINT "ShowcasePackage_max_areas_positive" CHECK ("maxAreas" IS NULL OR "maxAreas" > 0);

-- The other half of the namespace rule. Validated against existing rows on
-- purpose: a collision that already exists must stop this deployment rather
-- than be admitted.
ALTER TABLE "OfferCreditPackage"
  ADD CONSTRAINT "OfferCreditPackage_slug_not_showcase" CHECK ("slug" NOT LIKE 'vitrin-%');

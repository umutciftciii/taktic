-- Vitrin phase two, step 8: a terms bump gates the next sale and nothing else.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Data effect on rows that already exist
-- ────────────────────────────────────────────────────────────────────────────
--
-- **No card, version, review row or placement is read, updated or deleted by
-- this file.** A card that is approved stays approved, a version that is live
-- stays live, and a placement that is on the air stays on the air with the same
-- `endAt` it had before. Bumping `SHOWCASE_PRICE_TERMS_VERSION` after this
-- migration changes exactly one thing: what the *next* vitrin checkout requires.
--
-- The two backfills below touch only rows this feature itself created, and both
-- are no-ops on every database the vitrin migrations have reached so far,
-- because no vitrin purchase or placement exists anywhere yet — the feature has
-- not been deployed. They are written out rather than skipped so this file is
-- correct on its own terms rather than by appeal to a fact about today.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why a table rather than a column on ShowcaseCardVersion
-- ────────────────────────────────────────────────────────────────────────────
--
-- `ShowcaseCardVersion.priceTermsVersion` already records an acceptance, and it
-- deliberately stays exactly as it is. It is welded to a version, and a version
-- is frozen the moment it leaves DRAFT — so "accept the new terms" through that
-- column would mean either writing to frozen content or producing a new version
-- and pushing an approved card back through moderation. Accepting terms is a
-- legal act. It must be performable without changing one thing a customer sees,
-- and that is what this table makes possible.

-- CreateTable
CREATE TABLE "ShowcaseCardPriceTermsAcceptance" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "termsTextSnapshot" TEXT NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseCardPriceTermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- There is no `updatedAt`, and that is the point: a row here is a record of
-- consent, and a record of consent that can move is not one. Nothing in the
-- application updates or deletes these rows.

-- An empty version string would be an acceptance of nothing, and the checkout
-- compares against a configured version — so an empty stored version could be
-- matched by an empty configuration and let a sale through on no terms at all.
-- Both halves are refused here. `btrim` rather than `<> ''` because a row of
-- spaces is the same nothing.
ALTER TABLE "ShowcaseCardPriceTermsAcceptance"
  ADD CONSTRAINT "ShowcaseCardPriceTermsAcceptance_version_not_blank"
    CHECK (btrim("termsVersion") <> ''),
  ADD CONSTRAINT "ShowcaseCardPriceTermsAcceptance_text_not_blank"
    CHECK (btrim("termsTextSnapshot") <> '');

-- CreateIndex — the idempotency rule itself. Accepting the same version twice
-- cannot produce a second row, so "one acceptance per card per version" holds
-- even when two requests race, rather than only when the service remembers to
-- look first.
CREATE UNIQUE INDEX "ShowcaseCardPriceTermsAcceptance_cardId_termsVersion_key"
  ON "ShowcaseCardPriceTermsAcceptance"("cardId", "termsVersion");

CREATE INDEX "ShowcaseCardPriceTermsAcceptance_providerId_acceptedAt_idx"
  ON "ShowcaseCardPriceTermsAcceptance"("providerId", "acceptedAt");

CREATE INDEX "ShowcaseCardPriceTermsAcceptance_termsVersion_acceptedAt_idx"
  ON "ShowcaseCardPriceTermsAcceptance"("termsVersion", "acceptedAt");

-- AddForeignKey — Restrict on the card and on the accepting account, for the
-- same reason every other pointer in this feature is: the row is the evidence,
-- and evidence whose subject can be deleted out from under it is not evidence.
ALTER TABLE "ShowcaseCardPriceTermsAcceptance" ADD CONSTRAINT "ShowcaseCardPriceTermsAcceptance_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShowcaseCardPriceTermsAcceptance" ADD CONSTRAINT "ShowcaseCardPriceTermsAcceptance_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShowcaseCardPriceTermsAcceptance" ADD CONSTRAINT "ShowcaseCardPriceTermsAcceptance_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- The purchase records which acceptance it was opened against
-- ────────────────────────────────────────────────────────────────────────────
--
-- Written in the same transaction that creates the purchase row, from an
-- acceptance read in that transaction. There is therefore no ordering of writes
-- in which a vitrin purchase exists and the buyer's acceptance does not — which
-- is the difference between a rule and a rule with a race in it.

-- AlterTable
ALTER TABLE "PackagePurchase"
  ADD COLUMN "showcasePriceTermsAcceptanceId" TEXT;

ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcasePriceTermsAcceptanceId_fkey"
  FOREIGN KEY ("showcasePriceTermsAcceptanceId") REFERENCES "ShowcaseCardPriceTermsAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PackagePurchase_showcasePriceTermsAcceptanceId_idx"
  ON "PackagePurchase"("showcasePriceTermsAcceptanceId");

-- The discriminator CHECK gains a fifth column. Dropped and recreated rather
-- than added beside the old one, so there is exactly one constraint answering
-- "which columns must a SHOWCASE_PACKAGE row carry" — two overlapping ones
-- would be two places to keep in step.
--
-- Every OFFER_PACKAGE row satisfies the new form for the same reason it
-- satisfied the old one: the new column is NULL on every existing row.
ALTER TABLE "PackagePurchase"
  DROP CONSTRAINT "PackagePurchase_showcase_card_matches_kind";

ALTER TABLE "PackagePurchase"
  ADD CONSTRAINT "PackagePurchase_showcase_card_matches_kind" CHECK (
    ("kind" = 'SHOWCASE_PACKAGE' AND "showcaseCardId" IS NOT NULL
                                 AND "showcaseCardVersionId" IS NOT NULL
                                 AND "durationDaysSnapshot" IS NOT NULL
                                 AND "showcasePriceTermsAcceptanceId" IS NOT NULL)
    OR
    ("kind" = 'OFFER_PACKAGE'    AND "showcaseCardId" IS NULL
                                 AND "showcaseCardVersionId" IS NULL
                                 AND "durationDaysSnapshot" IS NULL
                                 AND "showcasePriceTermsAcceptanceId" IS NULL)
  );

-- ────────────────────────────────────────────────────────────────────────────
-- The placement carries the customer-facing snapshot
-- ────────────────────────────────────────────────────────────────────────────
--
-- The version *and* the sentence, because the sentence is what a customer
-- reading a card is shown. A run bought under v1 goes on showing v1's text
-- after the platform moves to v2 — the same snapshot discipline the price and
-- the duration already follow, applied to a legal statement. Deriving the text
-- from the current constant instead would let a bump silently rewrite what a
-- customer was told about a run bought weeks earlier.

-- AlterTable — added nullable, backfilled, then made NOT NULL. A default would
-- have been quicker and would also have invented an acceptance for any row it
-- touched; there is no honest default for "what terms was this sold under".
ALTER TABLE "ShowcasePlacement"
  ADD COLUMN "priceTermsVersionSnapshot" TEXT,
  ADD COLUMN "priceTermsTextSnapshot" TEXT;

-- Backfill from the purchase's acceptance. A no-op today: no placement exists
-- in any database. If one somehow did and had no acceptance behind it, the
-- SET NOT NULL below fails and the migration stops — which is the correct
-- outcome, because the alternative is a placement claiming terms nobody agreed
-- to.
UPDATE "ShowcasePlacement" AS p
   SET "priceTermsVersionSnapshot" = a."termsVersion",
       "priceTermsTextSnapshot"    = a."termsTextSnapshot"
  FROM "PackagePurchase" AS pp
  JOIN "ShowcaseCardPriceTermsAcceptance" AS a
    ON a."id" = pp."showcasePriceTermsAcceptanceId"
 WHERE pp."id" = p."purchaseId";

ALTER TABLE "ShowcasePlacement"
  ALTER COLUMN "priceTermsVersionSnapshot" SET NOT NULL,
  ALTER COLUMN "priceTermsTextSnapshot" SET NOT NULL;

ALTER TABLE "ShowcasePlacement"
  ADD CONSTRAINT "ShowcasePlacement_price_terms_not_blank" CHECK (
    btrim("priceTermsVersionSnapshot") <> '' AND btrim("priceTermsTextSnapshot") <> ''
  );

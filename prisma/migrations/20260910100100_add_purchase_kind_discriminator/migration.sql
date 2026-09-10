-- Vitrin phase two, step 2 of 7: one money rail, two catalogues.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Data effect: none. Backfill: none, and none is possible or needed.
-- ────────────────────────────────────────────────────────────────────────────
--
-- Every existing row gets `kind = 'OFFER_PACKAGE'` from the column default,
-- which is precisely what every existing row already meant, and four new NULL
-- columns. No row is read, updated or deleted by this file. All three CHECK
-- constraints below are satisfied by every existing row by construction:
-- `kind` is OFFER_PACKAGE, `packageId` is set (it was NOT NULL until this
-- migration), and the four showcase columns are NULL.
--
-- `ALTER COLUMN … DROP NOT NULL` is a catalogue-only change in PostgreSQL: it
-- does not rewrite the table and does not take a long lock.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Backwards compatibility, and the one ordering rule
-- ────────────────────────────────────────────────────────────────────────────
--
-- This migration is safe to run against a database whose application has NOT
-- been deployed yet. Existing code reads `packageId` and finds it on every row;
-- it does not know about `kind` and never writes it.
--
-- The reverse is not true, and it is the one gate that matters here: reverting
-- `packageId` to NOT NULL is only possible while no vitrin purchase exists. Do
-- not deploy code that can open a vitrin checkout between this migration and
-- the placement migration that follows it.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why not a separate ShowcasePurchase table
-- ────────────────────────────────────────────────────────────────────────────
--
-- `providerOrderId` and `paymentReference` are unique *on this table*, and that
-- is the whole of the guarantee that one settled payment provider order settles
-- exactly one purchase. Split across two tables, one Lemon Squeezy order could
-- close a row in each and no constraint in the database would see it. The rail
-- stays single; only the catalogue is doubled.

-- AlterTable
ALTER TABLE "PackagePurchase"
  ADD COLUMN "kind" "PackagePurchaseKind" NOT NULL DEFAULT 'OFFER_PACKAGE',
  ADD COLUMN "showcasePackageId" TEXT,
  ADD COLUMN "showcaseCardId" TEXT,
  ADD COLUMN "showcaseCardVersionId" TEXT,
  ADD COLUMN "durationDaysSnapshot" INTEGER,
  ALTER COLUMN "packageId" DROP NOT NULL;

-- AddForeignKey — Restrict on all three. A catalogue row, a card or a version
-- that a settled payment points at is part of the record of what was sold.
ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcasePackageId_fkey"
  FOREIGN KEY ("showcasePackageId") REFERENCES "ShowcasePackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcaseCardId_fkey"
  FOREIGN KEY ("showcaseCardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PackagePurchase" ADD CONSTRAINT "PackagePurchase_showcaseCardVersionId_fkey"
  FOREIGN KEY ("showcaseCardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The discriminator's own rules. Each is a rule the settlement path also
-- enforces, written here as well because a rule only the service knows is a
-- rule a future code path can forget.
ALTER TABLE "PackagePurchase"
  ADD CONSTRAINT "PackagePurchase_kind_matches_package" CHECK (
    ("kind" = 'OFFER_PACKAGE'    AND "packageId" IS NOT NULL AND "showcasePackageId" IS NULL)
    OR
    ("kind" = 'SHOWCASE_PACKAGE' AND "showcasePackageId" IS NOT NULL AND "packageId" IS NULL)
  ),
  ADD CONSTRAINT "PackagePurchase_showcase_card_matches_kind" CHECK (
    ("kind" = 'SHOWCASE_PACKAGE' AND "showcaseCardId" IS NOT NULL
                                 AND "showcaseCardVersionId" IS NOT NULL
                                 AND "durationDaysSnapshot" IS NOT NULL)
    OR
    ("kind" = 'OFFER_PACKAGE'    AND "showcaseCardId" IS NULL
                                 AND "showcaseCardVersionId" IS NULL
                                 AND "durationDaysSnapshot" IS NULL)
  ),
  -- The one that matters most. A vitrin purchase sells visibility, never offer
  -- capacity, so a settlement path that forgot to branch fails on a constraint
  -- here rather than silently loading somebody's credit balance.
  ADD CONSTRAINT "PackagePurchase_showcase_grants_no_credit" CHECK (
    "kind" <> 'SHOWCASE_PACKAGE'
    OR ("creditAmountSnapshot" = 0 AND "creditTransactionId" IS NULL)
  );

-- CreateIndex
CREATE INDEX "PackagePurchase_kind_status_idx" ON "PackagePurchase"("kind", "status");
CREATE INDEX "PackagePurchase_showcaseCardId_idx" ON "PackagePurchase"("showcaseCardId");

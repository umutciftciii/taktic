-- Vitrin phase two, step 3 of 7: the paid run, the publish index, and the two
-- audit trails behind them.
--
-- Purely additive: three enum types and four tables. Not one existing table,
-- column, index or constraint is touched, and there is nothing to back fill —
-- every table here starts empty and only a settled payment ever writes one.

-- CreateEnum
CREATE TYPE "ShowcasePlacementStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShowcasePlacementSuspendReason" AS ENUM ('ADMIN_ACTION', 'CATEGORY_CLOSED', 'SYSTEM_PUBLISH_BLOCK', 'CARD_ARCHIVED', 'AREA_NO_LONGER_COVERED', 'PROVIDER_NOT_APPROVED');

-- CreateEnum
CREATE TYPE "ShowcaseVersionChangeTrigger" AS ENUM ('ADMIN_APPROVAL', 'AREA_NARROWING');

-- CreateTable
CREATE TABLE "ShowcasePlacement" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "showcasePackageId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "pinnedVersionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "kindSnapshot" "ShowcaseCardKind" NOT NULL,
    "packageNameSnapshot" TEXT NOT NULL,
    "priceAmountSnapshot" INTEGER NOT NULL,
    "currencySnapshot" TEXT NOT NULL DEFAULT 'TRY',
    "durationDaysSnapshot" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "ShowcasePlacementStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" "ShowcasePlacementSuspendReason",
    "totalExtendedMs" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcasePlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcasePlacementShelf" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "scope" "ProviderServiceAreaScope" NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "neighborhood" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePlacementShelf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcasePlacementSuspension" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "reason" "ShowcasePlacementSuspendReason" NOT NULL,
    "extendsClock" BOOLEAN NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endAtBefore" TIMESTAMP(3) NOT NULL,
    "endAtAfter" TIMESTAMP(3),
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePlacementSuspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcasePlacementVersionChange" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "fromVersionId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "trigger" "ShowcaseVersionChangeTrigger" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePlacementVersionChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcasePlacement_purchaseId_key" ON "ShowcasePlacement"("purchaseId");
CREATE INDEX "ShowcasePlacement_providerId_status_endAt_idx" ON "ShowcasePlacement"("providerId", "status", "endAt");
CREATE INDEX "ShowcasePlacement_status_endAt_idx" ON "ShowcasePlacement"("status", "endAt");
CREATE INDEX "ShowcasePlacement_categoryId_status_endAt_idx" ON "ShowcasePlacement"("categoryId", "status", "endAt");
CREATE INDEX "ShowcasePlacement_pinnedVersionId_idx" ON "ShowcasePlacement"("pinnedVersionId");

-- One card's slot cannot be sold twice at once.
--
-- **This is not an anti-boost rule.** A provider may open as many cards as they
-- like and buy a package for every one of them; an earlier draft of this design
-- had a per-shelf uniqueness constraint and it was removed, because it cut off
-- the revenue model at the point of sale. This index says only that a *second*
-- payment against a card that already has a live run would add nothing to what
-- the first one publishes.
--
-- Balance between providers is a ranking problem, and it is solved in the feed
-- query's `provider_rank` — which spreads one provider's cards across
-- successive rounds rather than refusing to sell them.
CREATE UNIQUE INDEX "ShowcasePlacement_one_live_per_card"
  ON "ShowcasePlacement" ("cardId")
  WHERE "status" IN ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED');

-- A run that ends before it starts is not a run.
ALTER TABLE "ShowcasePlacement"
  ADD CONSTRAINT "ShowcasePlacement_window_ordered" CHECK ("endAt" > "startAt"),
  -- Off the air and why, together or not at all. A `suspendedAt` with no
  -- reason is a placement nobody can explain.
  ADD CONSTRAINT "ShowcasePlacement_suspension_pairing" CHECK (
    ("suspendedAt" IS NULL AND "suspendReason" IS NULL)
    OR ("suspendedAt" IS NOT NULL AND "suspendReason" IS NOT NULL)
  ),
  ADD CONSTRAINT "ShowcasePlacement_extension_non_negative" CHECK ("totalExtendedMs" >= 0);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcasePlacementShelf_placementId_categoryId_areaKey_key"
  ON "ShowcasePlacementShelf"("placementId", "categoryId", "areaKey");
CREATE INDEX "ShowcasePlacementShelf_placementId_idx" ON "ShowcasePlacementShelf"("placementId");
CREATE INDEX "ShowcasePlacementShelf_providerId_idx" ON "ShowcasePlacementShelf"("providerId");
CREATE INDEX "ShowcasePlacementShelf_areaKey_categoryId_endAt_idx"
  ON "ShowcasePlacementShelf"("areaKey", "categoryId", "endAt");

-- The home page's own index. `areaKey` leads because it is the most selective
-- column: a visitor's location produces at most three candidate keys, and this
-- turns the feed into an index lookup rather than a coverage scan.
CREATE INDEX "ShowcasePlacementShelf_publish_idx"
  ON "ShowcasePlacementShelf" ("areaKey", "categoryId", "endAt") WHERE "active";

-- The prefix scan for a visitor who named only a province.
CREATE INDEX "ShowcasePlacementShelf_area_prefix_idx"
  ON "ShowcasePlacementShelf" ("areaKey" text_pattern_ops) WHERE "active";

-- Three segments, two separators, and no segment may contain the separator.
-- The same shape rule ShowcaseCardVersionArea carries, on the table that is
-- read by a public endpoint.
ALTER TABLE "ShowcasePlacementShelf"
  ADD CONSTRAINT "ShowcasePlacementShelf_area_key_shape"
  CHECK ("areaKey" ~ '^[^|]+\|[^|]*\|[^|]*$');

-- CreateIndex
CREATE INDEX "ShowcasePlacementSuspension_placementId_startedAt_idx"
  ON "ShowcasePlacementSuspension"("placementId", "startedAt");

-- One placement is off the air for one reason at a time.
CREATE UNIQUE INDEX "ShowcasePlacementSuspension_one_open_per_placement"
  ON "ShowcasePlacementSuspension" ("placementId") WHERE "endedAt" IS NULL;

-- The database half of the clock rule. A suspension that does not stop the
-- clock may never have moved `endAt`, so "a provider archived their card and
-- got the time back" is unrepresentable rather than merely refused by the
-- service that computes it.
ALTER TABLE "ShowcasePlacementSuspension"
  ADD CONSTRAINT "ShowcasePlacementSuspension_extension_matches_flag" CHECK (
    "extendsClock" OR "endAtAfter" IS NULL OR "endAtAfter" = "endAtBefore"
  ),
  -- A closed suspension records where the clock ended up; an open one has not
  -- got there yet.
  ADD CONSTRAINT "ShowcasePlacementSuspension_closure_pairing" CHECK (
    ("endedAt" IS NULL AND "endAtAfter" IS NULL)
    OR ("endedAt" IS NOT NULL AND "endAtAfter" IS NOT NULL)
  );

-- CreateIndex
CREATE UNIQUE INDEX "ShowcasePlacementVersionChange_placementId_toVersionId_key"
  ON "ShowcasePlacementVersionChange"("placementId", "toVersionId");
CREATE INDEX "ShowcasePlacementVersionChange_placementId_createdAt_idx"
  ON "ShowcasePlacementVersionChange"("placementId", "createdAt");

-- A re-pin moves somewhere else.
ALTER TABLE "ShowcasePlacementVersionChange"
  ADD CONSTRAINT "ShowcasePlacementVersionChange_moves" CHECK ("fromVersionId" <> "toVersionId");

-- AddForeignKey
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_showcasePackageId_fkey" FOREIGN KEY ("showcasePackageId") REFERENCES "ShowcasePackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_pinnedVersionId_fkey" FOREIGN KEY ("pinnedVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacement" ADD CONSTRAINT "ShowcasePlacement_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade, and the only one in this migration. A shelf row is not a record of
-- anything that happened; it is a derived index entry, and it means nothing
-- without the placement it indexes.
ALTER TABLE "ShowcasePlacementShelf" ADD CONSTRAINT "ShowcasePlacementShelf_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShowcasePlacementSuspension" ADD CONSTRAINT "ShowcasePlacementSuspension_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacementSuspension" ADD CONSTRAINT "ShowcasePlacementSuspension_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShowcasePlacementVersionChange" ADD CONSTRAINT "ShowcasePlacementVersionChange_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacementVersionChange" ADD CONSTRAINT "ShowcasePlacementVersionChange_fromVersionId_fkey" FOREIGN KEY ("fromVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcasePlacementVersionChange" ADD CONSTRAINT "ShowcasePlacementVersionChange_toVersionId_fkey" FOREIGN KEY ("toVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

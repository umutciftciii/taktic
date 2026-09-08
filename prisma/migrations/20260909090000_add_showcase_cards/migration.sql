-- Vitrin (showcase) cards, phase one: the card, its versions, their areas, and
-- the record of who decided what about them.
--
-- Purely additive. Three new enum types and five new tables; not one existing
-- table, column, index or constraint is altered, and no existing row is read,
-- rewritten or deleted. There is no backfill because there is nothing to back
-- fill: every table here starts empty and stays empty until a provider creates
-- a card through the new endpoints.
--
-- Nothing in this migration publishes anything. There is no package, no
-- placement, no lead and no customer-facing surface in this phase — an approved
-- card is a reviewed text that nothing yet renders to a visitor.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why the CHECK constraints below are here rather than in the Prisma schema
-- ────────────────────────────────────────────────────────────────────────────
--
-- Prisma cannot express a CHECK constraint, so each one lives in raw SQL — the
-- same arrangement `add_offer_package_entitlements` and
-- `add_provider_service_area_scope` already use. Each is a rule the application
-- also enforces, written here as well because a rule only the service knows is
-- a rule a future code path can forget.

-- CreateEnum
CREATE TYPE "ShowcaseCardKind" AS ENUM ('SERVICE', 'PROMOTION');

-- CreateEnum
CREATE TYPE "ShowcaseCardStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ShowcaseVersionReview" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ShowcaseCard" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" "ShowcaseCardKind" NOT NULL,
    "categoryId" TEXT NOT NULL,
    "status" "ShowcaseCardStatus" NOT NULL DEFAULT 'DRAFT',
    "liveVersionId" TEXT,
    "draftVersionId" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcaseCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcaseCardVersion" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "kindSnapshot" "ShowcaseCardKind" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "scopeIncluded" TEXT[],
    "scopeExcluded" TEXT[],
    "listedServicePriceAmount" INTEGER,
    "listedServiceCurrency" TEXT NOT NULL DEFAULT 'TRY',
    "imageUrl" TEXT,
    "responseSlaUrgentHours" INTEGER NOT NULL DEFAULT 3,
    "responseSlaNormalHours" INTEGER NOT NULL DEFAULT 24,
    "priceTermsVersion" TEXT,
    "priceTermsAcceptedAt" TIMESTAMP(3),
    "reviewStatus" "ShowcaseVersionReview" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcaseCardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcaseCardVersionArea" (
    "id" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "scope" "ProviderServiceAreaScope" NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "neighborhood" TEXT,
    "areaKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseCardVersionArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcaseCardReview" (
    "id" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "decision" "ShowcaseVersionReview" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseCardReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShowcaseCardAutoPublishAudit" (
    "id" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "previousVersionId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "removedAreaKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseCardAutoPublishAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCard_liveVersionId_key" ON "ShowcaseCard"("liveVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCard_draftVersionId_key" ON "ShowcaseCard"("draftVersionId");

-- CreateIndex
CREATE INDEX "ShowcaseCard_providerId_status_idx" ON "ShowcaseCard"("providerId", "status");

-- CreateIndex
CREATE INDEX "ShowcaseCard_providerId_createdAt_idx" ON "ShowcaseCard"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseCard_categoryId_status_idx" ON "ShowcaseCard"("categoryId", "status");

-- CreateIndex
CREATE INDEX "ShowcaseCard_status_idx" ON "ShowcaseCard"("status");

-- CreateIndex
CREATE INDEX "ShowcaseCardVersion_cardId_createdAt_idx" ON "ShowcaseCardVersion"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseCardVersion_reviewStatus_submittedAt_idx" ON "ShowcaseCardVersion"("reviewStatus", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCardVersion_cardId_versionNumber_key" ON "ShowcaseCardVersion"("cardId", "versionNumber");

-- CreateIndex
CREATE INDEX "ShowcaseCardVersionArea_cardVersionId_idx" ON "ShowcaseCardVersionArea"("cardVersionId");

-- CreateIndex
CREATE INDEX "ShowcaseCardVersionArea_areaKey_idx" ON "ShowcaseCardVersionArea"("areaKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCardVersionArea_cardVersionId_areaKey_key" ON "ShowcaseCardVersionArea"("cardVersionId", "areaKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCardReview_cardVersionId_key" ON "ShowcaseCardReview"("cardVersionId");

-- CreateIndex
CREATE INDEX "ShowcaseCardReview_reviewedById_createdAt_idx" ON "ShowcaseCardReview"("reviewedById", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseCardReview_createdAt_idx" ON "ShowcaseCardReview"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCardAutoPublishAudit_cardVersionId_key" ON "ShowcaseCardAutoPublishAudit"("cardVersionId");

-- CreateIndex
CREATE INDEX "ShowcaseCardAutoPublishAudit_cardId_createdAt_idx" ON "ShowcaseCardAutoPublishAudit"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseCardAutoPublishAudit_providerId_createdAt_idx" ON "ShowcaseCardAutoPublishAudit"("providerId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShowcaseCard" ADD CONSTRAINT "ShowcaseCard_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCard" ADD CONSTRAINT "ShowcaseCard_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCard" ADD CONSTRAINT "ShowcaseCard_liveVersionId_fkey" FOREIGN KEY ("liveVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCard" ADD CONSTRAINT "ShowcaseCard_draftVersionId_fkey" FOREIGN KEY ("draftVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardVersion" ADD CONSTRAINT "ShowcaseCardVersion_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardVersionArea" ADD CONSTRAINT "ShowcaseCardVersionArea_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardReview" ADD CONSTRAINT "ShowcaseCardReview_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardReview" ADD CONSTRAINT "ShowcaseCardReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardAutoPublishAudit" ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardAutoPublishAudit" ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardAutoPublishAudit" ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseCardAutoPublishAudit" ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- CHECK constraints. Prisma cannot express any of these.
-- ────────────────────────────────────────────────────────────────────────────

-- A SERVICE card carries a positive price; a PROMOTION card carries none.
--
-- Both halves, because only one would leave the other representable. Without
-- the first, a SERVICE card could advertise a fixed price by omitting the
-- number; without the second, a PROMOTION card — which the product says makes
-- no price claim — could quietly carry one, and every reader would then have to
-- decide for itself whether to print it.
--
-- `> 0` rather than `>= 0`: a fixed price of zero is not a price, it is a
-- statement about the work being free, and nothing in this product means that.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_price_matches_kind" CHECK (
    ("kindSnapshot" = 'SERVICE' AND "listedServicePriceAmount" IS NOT NULL AND "listedServicePriceAmount" > 0)
    OR ("kindSnapshot" = 'PROMOTION' AND "listedServicePriceAmount" IS NULL)
  );

-- One currency. The product is Turkish, every other amount in this schema is
-- minor-unit TRY, and a second currency is a decision about which market this
-- platform serves rather than a value a column should silently accept.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_currency_try" CHECK ("listedServiceCurrency" = 'TRY');

-- A fixed price for an unstated scope is the one thing this product must never
-- put on a card, so neither list may be empty. `coalesce(array_length(...), 0)`
-- because array_length returns NULL — not 0 — for an empty array.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_scope_not_empty" CHECK (
    coalesce(array_length("scopeIncluded", 1), 0) >= 1
    AND coalesce(array_length("scopeExcluded", 1), 0) >= 1
  );

-- The response promises, inside the bounds the product offers. The upper bounds
-- are what an operator would refuse anyway; having them here means a card
-- promising to answer an urgent request in three weeks cannot be stored at all.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_sla_bounds" CHECK (
    "responseSlaUrgentHours" BETWEEN 1 AND 24
    AND "responseSlaNormalHours" BETWEEN 1 AND 72
  );

-- An urgent promise may not be slower than the ordinary one. Two independent
-- bounds admit "urgent: 24 hours, normal: 2 hours", which is a card whose two
-- promises contradict each other.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_sla_ordered" CHECK (
    "responseSlaUrgentHours" <= "responseSlaNormalHours"
  );

-- A version that has left DRAFT carries the provider's acceptance of the
-- price-responsibility text, and a DRAFT carries none.
--
-- This is what makes "submitted without accepting" unrepresentable rather than
-- merely refused by a service method. The second half matters as much as the
-- first: writing the current terms version onto a draft nobody has submitted
-- would record a consent that was never given, which is the same lie in the
-- other direction.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_price_terms_on_submit" CHECK (
    ("reviewStatus" = 'DRAFT' AND "priceTermsVersion" IS NULL AND "priceTermsAcceptedAt" IS NULL)
    OR ("reviewStatus" <> 'DRAFT' AND "priceTermsVersion" IS NOT NULL AND "priceTermsAcceptedAt" IS NOT NULL)
  );

-- A version that has left DRAFT was submitted at some point, and a DRAFT has
-- not been. `publishedAt` is deliberately not paired to a status here: it is set
-- when a version goes live and stays set afterwards, and a version can be
-- APPROVED in this table before anything renders it.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_submitted_at_matches_status" CHECK (
    ("reviewStatus" = 'DRAFT' AND "submittedAt" IS NULL)
    OR ("reviewStatus" <> 'DRAFT' AND "submittedAt" IS NOT NULL)
  );

-- Version numbers start at 1 and count up.
ALTER TABLE "ShowcaseCardVersion"
  ADD CONSTRAINT "ShowcaseCardVersion_version_number_positive" CHECK ("versionNumber" >= 1);

-- The scope may not disagree with the levels it names — the identical rule
-- ProviderServiceArea_scope_levels applies to a provider's own coverage, and
-- for the identical reason: without it the column is a comment, and a CITY row
-- could secretly name a district.
ALTER TABLE "ShowcaseCardVersionArea"
  ADD CONSTRAINT "ShowcaseCardVersionArea_scope_levels" CHECK (
    ("scope" = 'CITY' AND "district" IS NULL AND "neighborhood" IS NULL)
    OR ("scope" = 'DISTRICT' AND "district" IS NOT NULL AND "neighborhood" IS NULL)
    OR ("scope" = 'NEIGHBORHOOD' AND "district" IS NOT NULL AND "neighborhood" IS NOT NULL)
  );

-- No level may be blank. A blank city passes every other constraint here and
-- matches nothing, forever, with nothing on screen to say why.
ALTER TABLE "ShowcaseCardVersionArea"
  ADD CONSTRAINT "ShowcaseCardVersionArea_levels_not_blank" CHECK (
    btrim("city") <> ''
    AND ("district" IS NULL OR btrim("district") <> '')
    AND ("neighborhood" IS NULL OR btrim("neighborhood") <> '')
  );

-- The key has exactly three "|"-separated segments and a non-empty first one.
--
-- It cannot check that the key is the *right* fold of the levels beside it —
-- that needs the Turkish-aware folding the application performs, which is not
-- expressible here. What it does check is that the column holds a key shaped
-- like one this application derives, so a hand-written row or a future path that
-- forgot to derive it fails loudly instead of storing an area that silently
-- matches nothing.
ALTER TABLE "ShowcaseCardVersionArea"
  ADD CONSTRAINT "ShowcaseCardVersionArea_area_key_shape" CHECK (
    "areaKey" ~ '^[^|]+\|[^|]*\|[^|]*$'
  );

-- A review is a decision, and only two decisions exist. DRAFT and PENDING are
-- states a version passes through, not outcomes anybody chose.
ALTER TABLE "ShowcaseCardReview"
  ADD CONSTRAINT "ShowcaseCardReview_decision_is_an_outcome" CHECK (
    "decision" IN ('APPROVED', 'REJECTED')
  );

-- A rejection carries a note the provider can act on. An approval has nothing to
-- say and may not invent one: a note on an approval would be an operator remark
-- travelling on a row the provider's own screen reads.
ALTER TABLE "ShowcaseCardReview"
  ADD CONSTRAINT "ShowcaseCardReview_note_matches_decision" CHECK (
    ("decision" = 'REJECTED' AND "note" IS NOT NULL AND btrim("note") <> '')
    OR ("decision" = 'APPROVED' AND "note" IS NULL)
  );

-- An automatic publication that removed nothing is not a narrowing, and this
-- table exists only to record narrowings. An empty array here would be a row
-- claiming a rule fired that could not have fired.
ALTER TABLE "ShowcaseCardAutoPublishAudit"
  ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_removed_not_empty" CHECK (
    coalesce(array_length("removedAreaKeys", 1), 0) >= 1
  );

-- A version cannot supersede itself.
ALTER TABLE "ShowcaseCardAutoPublishAudit"
  ADD CONSTRAINT "ShowcaseCardAutoPublishAudit_distinct_versions" CHECK (
    "cardVersionId" <> "previousVersionId"
  );

-- Vitrin phase two, step 5 of 7: the direct lead and the two columns that gate
-- it on ServiceRequest.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Data effect on ServiceRequest: two nullable columns, and no backfill
-- ────────────────────────────────────────────────────────────────────────────
--
-- No row is read, updated or deleted. Every existing request gets NULL in both
-- columns, and NULL is not a gap here — it is the correct and permanent answer:
-- "this request did not come from a vitrin card" and "no provider has exclusive
-- sight of it". Both are true of every request ever submitted before this
-- feature, and of every ordinary marketplace request after it.
--
-- A backfill would be a fabrication, and there is nothing to fabricate from.
--
-- PostgreSQL treats NULLs as distinct in a unique index, so millions of NULL
-- `showcaseLeadId` values coexist happily under one unique constraint — the
-- same property `ProviderProfile.userId` already relies on.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Backwards compatibility
-- ────────────────────────────────────────────────────────────────────────────
--
-- Safe to run before the application is deployed. `directShowcaseProviderId` is
-- NULL on every row, so `listMatchingRequests` — which does not know the column
-- exists — behaves identically for every request in the database.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why two columns rather than one
-- ────────────────────────────────────────────────────────────────────────────
--
-- `showcaseLeadId` says where the request came from and is never cleared;
-- `directShowcaseProviderId` says who may see it and is cleared exactly once,
-- by the customer's explicit RELEASE. Merged into one column, releasing a lead
-- to the market would destroy the record that a placement had produced it —
-- which is the number a provider's renewal decision rests on.

-- CreateTable
CREATE TABLE "ShowcaseLead" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "kindSnapshot" "ShowcaseCardKind" NOT NULL,
    "listedPriceSnapshot" INTEGER,
    "providerId" TEXT NOT NULL,
    "urgencyBucket" "ShowcaseLeadUrgency" NOT NULL,
    "slaHoursSnapshot" INTEGER NOT NULL,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "status" "ShowcaseLeadStatus" NOT NULL DEFAULT 'OPEN',
    "respondedAt" TIMESTAMP(3),
    "respondedOfferId" TEXT,
    "breachedAt" TIMESTAMP(3),
    "fallbackAskedAt" TIMESTAMP(3),
    "fallbackDecision" "ShowcaseLeadFallbackDecision",
    "fallbackDecidedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" "ShowcaseLeadCloseReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcaseLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseLead_requestId_key" ON "ShowcaseLead"("requestId");
CREATE UNIQUE INDEX "ShowcaseLead_respondedOfferId_key" ON "ShowcaseLead"("respondedOfferId");
CREATE INDEX "ShowcaseLead_providerId_status_slaDueAt_idx" ON "ShowcaseLead"("providerId", "status", "slaDueAt");
CREATE INDEX "ShowcaseLead_status_slaDueAt_idx" ON "ShowcaseLead"("status", "slaDueAt");
CREATE INDEX "ShowcaseLead_placementId_createdAt_idx" ON "ShowcaseLead"("placementId", "createdAt");
CREATE INDEX "ShowcaseLead_status_breachedAt_idx" ON "ShowcaseLead"("status", "breachedAt");

ALTER TABLE "ShowcaseLead"
  -- The SERVICE / PROMOTION price rule, restated on the lead. The version
  -- carries the same CHECK about its own text; this one is about the copy the
  -- customer actually read when they wrote to this business.
  ADD CONSTRAINT "ShowcaseLead_price_matches_kind" CHECK (
    ("kindSnapshot" = 'SERVICE'   AND "listedPriceSnapshot" IS NOT NULL)
    OR
    ("kindSnapshot" = 'PROMOTION' AND "listedPriceSnapshot" IS NULL)
  ),
  ADD CONSTRAINT "ShowcaseLead_sla_positive" CHECK ("slaHoursSnapshot" BETWEEN 1 AND 72),
  -- The database half of the consent rule. A `releasedAt` without the
  -- customer's RELEASE on the same row cannot be stored, so "the deadline
  -- passed, so we opened it up" is unrepresentable rather than merely refused.
  --
  -- Written with the explicit NULL test rather than as
  -- `"fallbackDecision" = 'RELEASE'`, and that spelling is the whole point. A
  -- CHECK passes when its expression evaluates to UNKNOWN, and
  -- `NULL = 'RELEASE'` is UNKNOWN — so the shorter version would have admitted
  -- exactly the row this constraint exists to refuse: a release with nobody's
  -- decision behind it. SQL's three-valued logic makes the obvious way of
  -- writing this rule silently do nothing.
  ADD CONSTRAINT "ShowcaseLead_release_needs_decision" CHECK (
    "releasedAt" IS NULL
    OR ("fallbackDecision" IS NOT NULL AND "fallbackDecision" = 'RELEASE')
  ),
  -- A decision and the moment it was taken travel together.
  ADD CONSTRAINT "ShowcaseLead_decision_pairing" CHECK (
    ("fallbackDecision" IS NULL AND "fallbackDecidedAt" IS NULL)
    OR ("fallbackDecision" IS NOT NULL AND "fallbackDecidedAt" IS NOT NULL)
  ),
  -- So does a closure and its reason.
  ADD CONSTRAINT "ShowcaseLead_closure_pairing" CHECK (
    ("closedAt" IS NULL AND "closeReason" IS NULL)
    OR ("closedAt" IS NOT NULL AND "closeReason" IS NOT NULL)
  ),
  -- An answered lead names the offer that answered it.
  ADD CONSTRAINT "ShowcaseLead_response_pairing" CHECK (
    ("respondedAt" IS NULL AND "respondedOfferId" IS NULL)
    OR ("respondedAt" IS NOT NULL AND "respondedOfferId" IS NOT NULL)
  );

-- AddForeignKey — Restrict throughout. A lead carries the customer's urgency
-- choice, the promise they were given and the decision they made; none of it
-- may disappear as a side effect of removing something else.
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowcaseLead" ADD CONSTRAINT "ShowcaseLead_respondedOfferId_fkey" FOREIGN KEY ("respondedOfferId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ServiceRequest"
  ADD COLUMN "showcaseLeadId" TEXT,
  ADD COLUMN "directShowcaseProviderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_showcaseLeadId_key" ON "ServiceRequest"("showcaseLeadId");
CREATE INDEX "ServiceRequest_directShowcaseProviderId_status_idx" ON "ServiceRequest"("directShowcaseProviderId", "status");

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_showcaseLeadId_fkey" FOREIGN KEY ("showcaseLeadId") REFERENCES "ShowcaseLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_directShowcaseProviderId_fkey" FOREIGN KEY ("directShowcaseProviderId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

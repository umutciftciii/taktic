-- CAMPAIGN-ENTITLEMENT-001: bounded vitrin offer allowances.
--
-- What this adds:
--
--   * OfferAllowanceGrant — one per ShowcasePlacement (UNIQUE
--     "showcasePlacementId"): SHOWCASE_FREE_OFFER_QUOTA (3) free offers the
--     placement's owner may spend on the direct leads that arrived through it;
--   * OfferAllowanceUsage — one append-only row per offer such a slot paid for
--     (UNIQUE "offerId", UNIQUE "showcaseLeadId", UNIQUE ("grantId","ordinal"));
--   * CHECKs: quotaTotal > 0, 0 <= quotaUsed <= quotaTotal, source ⇔ scope,
--     the void triple, ordinal >= 1, listCreditCostSnapshot >= 0;
--   * OfferAllowanceUsage_insert_guard — a usage row's provider is its grant's
--     provider, and its ordinal is a slot the grant has already claimed
--     (1..quotaUsed), whatever the writer;
--   * OfferAllowanceUsage_append_only — UPDATE and DELETE are refused.
--
-- Backfill (the one data statement, between the BACKFILL markers): every
-- placement that can still produce or answer a direct lead gets its grant,
-- with quotaTotal = (legacy free offers already answered through it) + 3 and
-- quotaUsed = that same count. "Can still" is:
--   - PENDING_ACTIVATION / ACTIVE inside its window, or
--   - SUSPENDED (a clock-stopping resume may move "endAt" forward again), or
--   - any status, when one of its leads is still waiting for its owner's
--     answer (lead OPEN / BREACHED, the request still gated to the owner and
--     SUBMITTED / APPROVED) — the "placement end" rule: a lead received while
--     the run was live keeps its allowance until it is resolved.
-- Legacy offers are only counted. No Offer row is touched and no usage row is
-- invented for them: usage absent + SHOWCASE_PLACEMENT + creditCost 0 stays
-- the record of the old unlimited behaviour.
--
-- Irreversibility boundary: while OfferAllowanceUsage is empty,
-- scripts/ops/campaign-entitlement-001-rollback.sql can drop all of this (it
-- refuses otherwise). Once a usage row exists the tables are financial audit
-- and are never dropped; recovery is forward-fix (or a code revert, which
-- returns to the old unlimited-free behaviour and leaves the tables in place).

-- CreateEnum
CREATE TYPE "OfferAllowanceSource" AS ENUM ('SHOWCASE_PLACEMENT');

-- CreateEnum
CREATE TYPE "OfferAllowanceBenefit" AS ENUM ('FREE_OFFER');

-- CreateEnum
CREATE TYPE "OfferAllowanceStatus" AS ENUM ('ACTIVE', 'VOID');

-- CreateTable
CREATE TABLE "OfferAllowanceGrant" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "source" "OfferAllowanceSource" NOT NULL,
    "benefit" "OfferAllowanceBenefit" NOT NULL,
    "showcasePlacementId" TEXT,
    "quotaTotal" INTEGER NOT NULL,
    "quotaUsed" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "status" "OfferAllowanceStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferAllowanceGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferAllowanceUsage" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "offerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "matchRoundId" TEXT NOT NULL,
    "showcaseLeadId" TEXT,
    "categoryId" TEXT NOT NULL,
    "listCreditCostSnapshot" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferAllowanceUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferAllowanceGrant_showcasePlacementId_key" ON "OfferAllowanceGrant"("showcasePlacementId");

-- CreateIndex
CREATE INDEX "OfferAllowanceGrant_providerId_status_idx" ON "OfferAllowanceGrant"("providerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OfferAllowanceUsage_offerId_key" ON "OfferAllowanceUsage"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferAllowanceUsage_showcaseLeadId_key" ON "OfferAllowanceUsage"("showcaseLeadId");

-- CreateIndex
CREATE INDEX "OfferAllowanceUsage_providerId_consumedAt_idx" ON "OfferAllowanceUsage"("providerId", "consumedAt");

-- CreateIndex
CREATE INDEX "OfferAllowanceUsage_requestId_idx" ON "OfferAllowanceUsage"("requestId");

-- CreateIndex
CREATE INDEX "OfferAllowanceUsage_matchRoundId_idx" ON "OfferAllowanceUsage"("matchRoundId");

-- CreateIndex
CREATE INDEX "OfferAllowanceUsage_categoryId_idx" ON "OfferAllowanceUsage"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferAllowanceUsage_grantId_ordinal_key" ON "OfferAllowanceUsage"("grantId", "ordinal");

-- AddForeignKey
ALTER TABLE "OfferAllowanceGrant" ADD CONSTRAINT "OfferAllowanceGrant_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceGrant" ADD CONSTRAINT "OfferAllowanceGrant_showcasePlacementId_fkey" FOREIGN KEY ("showcasePlacementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceGrant" ADD CONSTRAINT "OfferAllowanceGrant_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OfferAllowanceGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_matchRoundId_fkey" FOREIGN KEY ("matchRoundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_showcaseLeadId_fkey" FOREIGN KEY ("showcaseLeadId") REFERENCES "ShowcaseLead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferAllowanceUsage" ADD CONSTRAINT "OfferAllowanceUsage_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The invariants, at the database.
ALTER TABLE "OfferAllowanceGrant"
  ADD CONSTRAINT "OfferAllowanceGrant_quota_total_positive" CHECK ("quotaTotal" > 0),
  ADD CONSTRAINT "OfferAllowanceGrant_quota_used_bounded" CHECK ("quotaUsed" >= 0 AND "quotaUsed" <= "quotaTotal"),
  ADD CONSTRAINT "OfferAllowanceGrant_source_scope" CHECK (("source" = 'SHOWCASE_PLACEMENT') = ("showcasePlacementId" IS NOT NULL)),
  ADD CONSTRAINT "OfferAllowanceGrant_void_shape" CHECK (
    ("status" = 'VOID') = ("voidedAt" IS NOT NULL)
    AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidedById" IS NULL)
  );

ALTER TABLE "OfferAllowanceUsage"
  ADD CONSTRAINT "OfferAllowanceUsage_ordinal_positive" CHECK ("ordinal" >= 1),
  ADD CONSTRAINT "OfferAllowanceUsage_list_cost_non_negative" CHECK ("listCreditCostSnapshot" >= 0);

-- A usage row spends a slot its own provider's grant has already claimed.
CREATE FUNCTION "OfferAllowanceUsage_insert_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grant_provider TEXT;
  grant_used INTEGER;
BEGIN
  SELECT "providerId", "quotaUsed" INTO grant_provider, grant_used
    FROM "OfferAllowanceGrant" WHERE "id" = NEW."grantId";

  -- A missing grant is the foreign key's error to raise, not this one's.
  IF grant_provider IS NULL THEN
    RETURN NEW;
  END IF;

  IF grant_provider <> NEW."providerId" THEN
    RAISE EXCEPTION 'OfferAllowanceUsage provider % does not own grant %', NEW."providerId", NEW."grantId"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."ordinal" > grant_used THEN
    RAISE EXCEPTION 'OfferAllowanceUsage ordinal % is beyond the slots grant % has claimed (%)',
      NEW."ordinal", NEW."grantId", grant_used
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "OfferAllowanceUsage_insert_guard"
  BEFORE INSERT ON "OfferAllowanceUsage"
  FOR EACH ROW EXECUTE FUNCTION "OfferAllowanceUsage_insert_guard_fn"();

-- The usage trail is append-only.
CREATE FUNCTION "OfferAllowanceUsage_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OfferAllowanceUsage is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "OfferAllowanceUsage_append_only"
  BEFORE UPDATE OR DELETE ON "OfferAllowanceUsage"
  FOR EACH ROW EXECUTE FUNCTION "OfferAllowanceUsage_append_only_fn"();

-- BEGIN BACKFILL
INSERT INTO "OfferAllowanceGrant" (
  "id", "providerId", "source", "benefit", "showcasePlacementId",
  "quotaTotal", "quotaUsed", "validFrom", "status", "grantedAt", "updatedAt"
)
SELECT
  'oag_' || p."id",
  p."providerId",
  'SHOWCASE_PLACEMENT',
  'FREE_OFFER',
  p."id",
  legacy."count" + 3,
  legacy."count",
  p."startAt",
  'ACTIVE',
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
FROM "ShowcasePlacement" p
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS "count"
  FROM "Offer" o
  JOIN "ShowcaseLead" l
    ON l."requestId" = o."requestId"
   AND l."providerId" = o."providerId"
  WHERE l."placementId" = p."id"
    AND o."entitlementSource" = 'SHOWCASE_PLACEMENT'
) legacy
WHERE (p."status" IN ('PENDING_ACTIVATION', 'ACTIVE') AND p."endAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
   OR p."status" = 'SUSPENDED'
   OR EXISTS (
     SELECT 1
     FROM "ShowcaseLead" gl
     JOIN "ServiceRequest" r ON r."id" = gl."requestId"
     WHERE gl."placementId" = p."id"
       AND gl."status" IN ('OPEN', 'BREACHED')
       AND r."directShowcaseProviderId" = gl."providerId"
       AND r."status" IN ('SUBMITTED', 'APPROVED')
   )
ON CONFLICT ("showcasePlacementId") DO NOTHING;
-- END BACKFILL

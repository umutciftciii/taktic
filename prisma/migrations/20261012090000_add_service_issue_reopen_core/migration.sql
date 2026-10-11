-- REL-002 Faz 3 (M3): customer service issue, round reopen, provider exclusion.
--
-- What this adds:
--
--   * MatchRoundStatus += FAILED (terminal), MatchRoundOpenedBy += SERVICE_ISSUE
--     and ADMIN (ADMIN is reserved for Faz 5 and written by nothing yet),
--     ServiceRequestStatus += MATCH_REVIEW, NumberedEntityType +=
--     SERVICE_INCIDENT, AdminPermission += SERVICE_ISSUE_SETTING_WRITE;
--   * ProviderServiceIncident (the record behind a FAILED round) and
--     ServiceRequestProviderExclusion (a provider that may never act on the
--     request again), both empty;
--   * ServiceRequestMatchRound.failureIncidentId, the FAILED round shape, and
--     FAILED in the terminal-status trigger;
--   * the Offer INSERT backstop: an offer is refused when its provider is
--     excluded from the request or its round is not the request's current
--     OPEN round;
--   * OperationsSettings.serviceIssueReportingEnabled, false (the feature
--     ships off).
--
-- Additive only. No existing row is rewritten: the new column is nullable, the
-- new flag's default is a constant (metadata-only), the new tables are empty,
-- and the new CHECKs hold trivially (no round is FAILED and no
-- failureIncidentId is set before this runs).
--
-- One migration, one transaction. A value added by ALTER TYPE … ADD VALUE
-- cannot be *used* in the transaction that adds it (PostgreSQL ≥ 12 allows the
-- ADD itself). Nothing below uses one as an enum literal: the new CHECKs and
-- trigger bodies compare `"status"::text` with a text literal, which never
-- casts the literal to the enum, so the migration does not need to be split
-- in two. The application uses the new values only after this commits. The
-- two new enum types (ServiceIssueReason, ProviderIncidentStatus,
-- ServiceIssueEligibilityBasis) are created here, so their values are usable
-- here. The ADD VALUEs carry IF NOT EXISTS: PostgreSQL cannot drop an enum
-- value, so scripts/ops/rel-002-m3-rollback.sql leaves them in place, and a
-- re-deploy after that rollback must not fail on them.
--
-- Irreversibility boundary: this migration on its own can be rolled back by
-- hand while no round is FAILED (drop the objects below). Once the feature
-- flag is on and a real Round 2 exists, the REL-002 M2 rollback script refuses
-- (more than one round per request) and there is no backward schema rollback:
-- recovery is forward-fix only (REL-002 §32.9).

-- CreateEnum
CREATE TYPE "ServiceIssueReason" AS ENUM ('PROVIDER_NO_SHOW', 'WORK_NOT_STARTED', 'WORK_NOT_COMPLETED', 'PROVIDER_STOPPED_WORK', 'PROVIDER_CANCELLED_BEFORE_START', 'OTHER');

-- CreateEnum
CREATE TYPE "ProviderIncidentStatus" AS ENUM ('REPORTED', 'PROVIDER_RESPONDED', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ServiceIssueEligibilityBasis" AS ENUM ('OFFER_DATES', 'PROVIDER_CANCELLATION');

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'SERVICE_ISSUE_SETTING_WRITE';

-- AlterEnum
ALTER TYPE "MatchRoundOpenedBy" ADD VALUE IF NOT EXISTS 'SERVICE_ISSUE';
ALTER TYPE "MatchRoundOpenedBy" ADD VALUE IF NOT EXISTS 'ADMIN';

-- AlterEnum
ALTER TYPE "MatchRoundStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- AlterEnum
ALTER TYPE "NumberedEntityType" ADD VALUE IF NOT EXISTS 'SERVICE_INCIDENT';

-- AlterEnum
ALTER TYPE "ServiceRequestStatus" ADD VALUE IF NOT EXISTS 'MATCH_REVIEW';

-- AlterTable
ALTER TABLE "OperationsSettings" ADD COLUMN     "serviceIssueReportingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ServiceRequestMatchRound" ADD COLUMN     "failureIncidentId" TEXT;

-- CreateTable
CREATE TABLE "ProviderServiceIncident" (
    "id" TEXT NOT NULL,
    "incidentNumber" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "reason" "ServiceIssueReason" NOT NULL,
    "customerNote" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promisedStartDate" TIMESTAMP(3),
    "promisedEndDate" TIMESTAMP(3),
    "eligibilityBasis" "ServiceIssueEligibilityBasis" NOT NULL,
    "status" "ProviderIncidentStatus" NOT NULL DEFAULT 'REPORTED',
    "providerResponse" TEXT,
    "providerRespondedAt" TIMESTAMP(3),
    "providerRespondedById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderServiceIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequestProviderExclusion" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "sourceRoundId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "reason" "ServiceIssueReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestProviderExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_incidentNumber_key" ON "ProviderServiceIncident"("incidentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_roundId_key" ON "ProviderServiceIncident"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_offerId_key" ON "ProviderServiceIncident"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_idempotencyKey_key" ON "ProviderServiceIncident"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProviderServiceIncident_providerId_status_idx" ON "ProviderServiceIncident"("providerId", "status");

-- CreateIndex
CREATE INDEX "ProviderServiceIncident_status_reportedAt_idx" ON "ProviderServiceIncident"("status", "reportedAt");

-- CreateIndex
CREATE INDEX "ProviderServiceIncident_customerUserId_reportedAt_idx" ON "ProviderServiceIncident"("customerUserId", "reportedAt");

-- CreateIndex
CREATE INDEX "ProviderServiceIncident_requestId_idx" ON "ProviderServiceIncident"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_id_roundId_key" ON "ProviderServiceIncident"("id", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_id_requestId_providerId_key" ON "ProviderServiceIncident"("id", "requestId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestProviderExclusion_incidentId_key" ON "ServiceRequestProviderExclusion"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestProviderExclusion_requestId_providerId_key" ON "ServiceRequestProviderExclusion"("requestId", "providerId");

-- CreateIndex
CREATE INDEX "ServiceRequestProviderExclusion_providerId_idx" ON "ServiceRequestProviderExclusion"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestMatchRound_failureIncidentId_key" ON "ServiceRequestMatchRound"("failureIncidentId");

-- AddForeignKey
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_failureIncidentId_id_fkey" FOREIGN KEY ("failureIncidentId", "id") REFERENCES "ProviderServiceIncident"("id", "roundId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_roundId_requestId_fkey" FOREIGN KEY ("roundId", "requestId") REFERENCES "ServiceRequestMatchRound"("id", "requestId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_offerId_roundId_fkey" FOREIGN KEY ("offerId", "roundId") REFERENCES "Offer"("id", "matchRoundId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_providerRespondedById_fkey" FOREIGN KEY ("providerRespondedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestProviderExclusion" ADD CONSTRAINT "ServiceRequestProviderExclusion_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestProviderExclusion" ADD CONSTRAINT "ServiceRequestProviderExclusion_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestProviderExclusion" ADD CONSTRAINT "ServiceRequestProviderExclusion_sourceRoundId_requestId_fkey" FOREIGN KEY ("sourceRoundId", "requestId") REFERENCES "ServiceRequestMatchRound"("id", "requestId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestProviderExclusion" ADD CONSTRAINT "ServiceRequestProviderExclusion_incidentId_requestId_provi_fkey" FOREIGN KEY ("incidentId", "requestId", "providerId") REFERENCES "ProviderServiceIncident"("id", "requestId", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw-SQL invariants (Prisma cannot express these) ─────────────────────────

-- Incident: the customer's note. Trimmed and whitespace-collapsed by the
-- application; OTHER and PROVIDER_CANCELLED_BEFORE_START need a real one.
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_note_rules"
    CHECK (
        ("customerNote" IS NULL OR (char_length("customerNote") <= 1000 AND "customerNote" = btrim("customerNote")))
        AND ("reason" NOT IN ('OTHER', 'PROVIDER_CANCELLED_BEFORE_START')
             OR char_length(btrim(coalesce("customerNote", ''))) >= 20)
    );

-- The rule that let the issue be reported matches the reason, and every
-- incident carries the promised days it was judged against (there is no
-- legacy fallback: a match without them is a support case, not an incident).
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_eligibility_shape"
    CHECK (
        ("reason" = 'PROVIDER_CANCELLED_BEFORE_START') = ("eligibilityBasis" = 'PROVIDER_CANCELLATION')
        AND "promisedStartDate" IS NOT NULL
        AND "promisedEndDate" IS NOT NULL
        AND "promisedEndDate" >= "promisedStartDate"
    );

-- The provider's response (Faz 4): all three columns or none, and
-- PROVIDER_RESPONDED only with a response on file.
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_response_shape"
    CHECK (
        ("providerResponse" IS NULL) = ("providerRespondedAt" IS NULL)
        AND ("providerResponse" IS NULL) = ("providerRespondedById" IS NULL)
        AND ("status" <> 'PROVIDER_RESPONDED' OR "providerResponse" IS NOT NULL)
    );

-- The staff decision (Faz 4): a decided incident names who and when, an
-- undecided one names nobody.
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_decision_shape"
    CHECK (
        ("status" IN ('CONFIRMED', 'DISMISSED')) = ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL)
        AND ("reviewedAt" IS NOT NULL OR "reviewNote" IS NULL)
    );

-- Round: the FAILED shape. The winner stays recorded (offer, provider,
-- matchedAt), with when and why it failed; no other terminal stamp.
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_failed_shape"
    CHECK ("status"::text <> 'FAILED' OR (
        "matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL AND "matchedAt" IS NOT NULL
        AND "failedAt" IS NOT NULL AND "failureIncidentId" IS NOT NULL
        AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "expiredAt" IS NULL
    ));

-- A failure incident only on a FAILED round (every other status already
-- requires failedAt IS NULL, M2).
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_failure_incident_only_when_failed"
    CHECK (("status"::text = 'FAILED') = ("failureIncidentId" IS NOT NULL));

-- Terminal immutability now covers FAILED, and a round's failure incident,
-- once written, never changes. Replaces M1's function in place; the trigger
-- is re-created to also fire on an UPDATE that names failureIncidentId.
CREATE OR REPLACE FUNCTION "match_round_terminal_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'ServiceRequestMatchRound % is % and its status cannot change (to %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."failureIncidentId" IS NOT NULL AND NEW."failureIncidentId" IS DISTINCT FROM OLD."failureIncidentId" THEN
    RAISE EXCEPTION 'ServiceRequestMatchRound % already failed on incident %; it cannot change',
      OLD."id", OLD."failureIncidentId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "MatchRound_terminal_status_immutable" ON "ServiceRequestMatchRound";
CREATE TRIGGER "MatchRound_terminal_status_immutable"
  BEFORE UPDATE OF "status", "failureIncidentId" ON "ServiceRequestMatchRound"
  FOR EACH ROW EXECUTE FUNCTION "match_round_terminal_guard_fn"();

-- Exclusions are permanent: a customer's decision about their own request,
-- kept whatever is later decided on the incident. TRUNCATE (test reset) does
-- not fire row triggers.
CREATE FUNCTION "service_request_provider_exclusion_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ServiceRequestProviderExclusion rows are permanent (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ServiceRequestProviderExclusion_append_only"
  BEFORE UPDATE OR DELETE ON "ServiceRequestProviderExclusion"
  FOR EACH ROW EXECUTE FUNCTION "service_request_provider_exclusion_append_only_fn"();

-- Incidents are never deleted (Faz 4 updates the response and decision
-- columns; nothing removes the record).
CREATE FUNCTION "provider_service_incident_no_delete_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ProviderServiceIncident rows are never deleted'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProviderServiceIncident_no_delete"
  BEFORE DELETE ON "ProviderServiceIncident"
  FOR EACH ROW EXECUTE FUNCTION "provider_service_incident_no_delete_fn"();

-- ── Offer INSERT backstop ────────────────────────────────────────────────────
-- The application decides both inside the offer transaction
-- (createOfferRecord); this makes them true of every writer, a raw INSERT
-- included:
--
--   PROVIDER_EXCLUDED   the provider is excluded from the request;
--   OFFER_ROUND_CLOSED  the offer's round is not the request's current round,
--                       or that round is not OPEN.
--
-- Ordering with M2's "Offer_round_link_default" (BEFORE INSERT, fills an
-- empty matchRoundId with the request's current round): PostgreSQL fires
-- same-timing row triggers in name order, and "Offer_round_link_default" <
-- "Offer_round_open_guard", so the guard always sees the round the row will
-- carry. The message starts with the code; the API maps it to a 409.
CREATE FUNCTION "offer_round_open_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_round  text;
  current_status text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ServiceRequestProviderExclusion" e
    WHERE e."requestId" = NEW."requestId" AND e."providerId" = NEW."providerId"
  ) THEN
    RAISE EXCEPTION 'PROVIDER_EXCLUDED: provider % is excluded from request %', NEW."providerId", NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT r."currentRoundId", mr."status"::text INTO current_round, current_status
  FROM "ServiceRequest" r
  JOIN "ServiceRequestMatchRound" mr ON mr."id" = r."currentRoundId"
  WHERE r."id" = NEW."requestId";

  IF current_round IS NULL OR NEW."matchRoundId" IS DISTINCT FROM current_round OR current_status <> 'OPEN' THEN
    RAISE EXCEPTION 'OFFER_ROUND_CLOSED: round % is not the open current round of request %', NEW."matchRoundId", NEW."requestId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Offer_round_open_guard"
  BEFORE INSERT ON "Offer"
  FOR EACH ROW EXECUTE FUNCTION "offer_round_open_guard_fn"();

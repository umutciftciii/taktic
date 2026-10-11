-- REL-002 Faz 4 (M4): incident adjudication and provider reliability.
--
-- What this adds:
--
--   * ProviderIncidentAdjudication — every staff decision on a provider
--     service incident, append-only. INITIAL (sequence 1) and CORRECTION
--     (sequence n+1, superseding exactly the row before it). The chain is
--     explicit — never "the newest createdAt" — and cannot leave its incident
--     (composite FKs);
--   * ProviderServiceIncident.effectiveAdjudicationId — the head of that
--     chain, moved only forward and only onto an adjudication of the same
--     incident; the incident's status and reviewed* columns are a projection of
--     it, held equal by a trigger;
--   * ProviderReliabilityReview — the staff follow-up a provider with three or
--     more effective CONFIRMED incidents in 90 days gets; at most one
--     unresolved per provider (partial unique). It stores no count: the
--     reliability level is always computed from the incidents;
--   * five AdminPermission values (SERVICE_INCIDENTS_READ / _ADJUDICATE /
--     _CORRECT, PROVIDER_RELIABILITY_READ / _MANAGE);
--   * the provider-response rules Faz 3 left to this phase (one response,
--     10..2000 trimmed, never after a decision), and the 90-day indexes.
--
-- Additive only. Nothing existing is rewritten: the new column is nullable,
-- the new tables are empty, and every new CHECK holds on today's rows (no
-- incident is decided — Faz 3 writes REPORTED only — and none has a response).
--
-- One migration, one transaction. The new AdminPermission values are not used
-- here (ADD VALUE ... IF NOT EXISTS, as M3: PostgreSQL cannot drop an enum
-- value, so scripts/ops/rel-002-m4-rollback.sql leaves them, and a re-deploy
-- after that rollback must not fail on them). The three new enum types are
-- created here and compared as text below.
--
-- Irreversibility boundary: while no adjudication and no review exists the
-- objects below can be dropped by hand (scripts/ops/rel-002-m4-rollback.sql,
-- which refuses otherwise). Once a decision is recorded there is no backward
-- schema rollback — the decision history is the audit — and recovery is
-- forward-fix only (REL-002 §33).

-- CreateEnum
CREATE TYPE "ProviderIncidentDecision" AS ENUM ('CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ProviderIncidentAdjudicationKind" AS ENUM ('INITIAL', 'CORRECTION');

-- CreateEnum
CREATE TYPE "ProviderReliabilityReviewStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'SERVICE_INCIDENTS_READ';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'SERVICE_INCIDENTS_ADJUDICATE';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'SERVICE_INCIDENTS_CORRECT';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'PROVIDER_RELIABILITY_READ';
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'PROVIDER_RELIABILITY_MANAGE';

-- AlterTable
ALTER TABLE "ProviderServiceIncident" ADD COLUMN     "effectiveAdjudicationId" TEXT;

-- CreateTable
CREATE TABLE "ProviderIncidentAdjudication" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "ProviderIncidentAdjudicationKind" NOT NULL,
    "decision" "ProviderIncidentDecision" NOT NULL,
    "rationale" TEXT NOT NULL,
    "decidedByAdminId" TEXT NOT NULL,
    "supersedesAdjudicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderIncidentAdjudication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderReliabilityReview" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "ProviderReliabilityReviewStatus" NOT NULL DEFAULT 'OPEN',
    "triggerIncidentId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBySystem" BOOLEAN NOT NULL DEFAULT true,
    "assignedAdminId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderReliabilityReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIncidentAdjudication_supersedesAdjudicationId_key" ON "ProviderIncidentAdjudication"("supersedesAdjudicationId");

-- CreateIndex
CREATE INDEX "ProviderIncidentAdjudication_decidedByAdminId_idx" ON "ProviderIncidentAdjudication"("decidedByAdminId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIncidentAdjudication_incidentId_sequence_key" ON "ProviderIncidentAdjudication"("incidentId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIncidentAdjudication_id_incidentId_key" ON "ProviderIncidentAdjudication"("id", "incidentId");

-- CreateIndex
CREATE INDEX "ProviderReliabilityReview_providerId_createdAt_idx" ON "ProviderReliabilityReview"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderReliabilityReview_status_openedAt_idx" ON "ProviderReliabilityReview"("status", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_effectiveAdjudicationId_key" ON "ProviderServiceIncident"("effectiveAdjudicationId");

-- CreateIndex
CREATE INDEX "ProviderServiceIncident_providerId_reportedAt_idx" ON "ProviderServiceIncident"("providerId", "reportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderServiceIncident_id_providerId_key" ON "ProviderServiceIncident"("id", "providerId");

-- AddForeignKey
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "ProviderServiceIncident_effectiveAdjudicationId_id_fkey" FOREIGN KEY ("effectiveAdjudicationId", "id") REFERENCES "ProviderIncidentAdjudication"("id", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIncidentAdjudication" ADD CONSTRAINT "ProviderIncidentAdjudication_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "ProviderServiceIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIncidentAdjudication" ADD CONSTRAINT "ProviderIncidentAdjudication_decidedByAdminId_fkey" FOREIGN KEY ("decidedByAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIncidentAdjudication" ADD CONSTRAINT "ProviderIncidentAdjudication_supersedesAdjudicationId_inci_fkey" FOREIGN KEY ("supersedesAdjudicationId", "incidentId") REFERENCES "ProviderIncidentAdjudication"("id", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ProviderReliabilityReview_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ProviderReliabilityReview_triggerIncidentId_providerId_fkey" FOREIGN KEY ("triggerIncidentId", "providerId") REFERENCES "ProviderServiceIncident"("id", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ProviderReliabilityReview_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ProviderReliabilityReview_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ProviderReliabilityReview_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw-SQL invariants (Prisma cannot express these) ─────────────────────────

-- Adjudication: INITIAL is sequence 1 and supersedes nothing; a CORRECTION is a
-- later sequence and supersedes something. With the (incidentId, sequence)
-- unique this is "one INITIAL per incident".
ALTER TABLE "ProviderIncidentAdjudication" ADD CONSTRAINT "Adjudication_kind_shape"
    CHECK (
        "sequence" >= 1
        AND ("kind"::text = 'INITIAL') = ("sequence" = 1)
        AND ("kind"::text = 'INITIAL') = ("supersedesAdjudicationId" IS NULL)
    );

-- The rationale is mandatory and meaningful: trimmed, 10..2000 characters
-- (the application also collapses whitespace).
ALTER TABLE "ProviderIncidentAdjudication" ADD CONSTRAINT "Adjudication_rationale_rules"
    CHECK ("rationale" = btrim("rationale") AND char_length("rationale") BETWEEN 10 AND 2000);

-- The chain is linear and follows the head: an INITIAL only on an undecided
-- incident, a CORRECTION only of the incident's current head and only as the
-- very next sequence. Two corrections racing on the same head cannot both
-- land: the second collides on (incidentId, sequence) or supersedes-unique.
CREATE FUNCTION "provider_incident_adjudication_chain_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_id   text;
  prev_seq  integer;
BEGIN
  SELECT i."effectiveAdjudicationId" INTO head_id
  FROM "ProviderServiceIncident" i WHERE i."id" = NEW."incidentId";

  IF NEW."kind"::text = 'INITIAL' THEN
    IF head_id IS NOT NULL THEN
      RAISE EXCEPTION 'INCIDENT_ALREADY_ADJUDICATED: incident % already has decision %', NEW."incidentId", head_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF head_id IS NULL OR NEW."supersedesAdjudicationId" IS DISTINCT FROM head_id THEN
    RAISE EXCEPTION 'INCIDENT_ADJUDICATION_CHANGED: correction of % on incident % does not supersede the current head %',
      NEW."supersedesAdjudicationId", NEW."incidentId", head_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a."sequence" INTO prev_seq
  FROM "ProviderIncidentAdjudication" a
  WHERE a."id" = NEW."supersedesAdjudicationId" AND a."incidentId" = NEW."incidentId";
  IF prev_seq IS NULL OR NEW."sequence" <> prev_seq + 1 THEN
    RAISE EXCEPTION 'INCIDENT_ADJUDICATION_CHANGED: correction sequence % does not follow %', NEW."sequence", prev_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProviderIncidentAdjudication_chain"
  BEFORE INSERT ON "ProviderIncidentAdjudication"
  FOR EACH ROW EXECUTE FUNCTION "provider_incident_adjudication_chain_fn"();

-- Decisions are never edited or removed; a correction is a new row. TRUNCATE
-- (test reset) does not fire row triggers.
CREATE FUNCTION "provider_incident_adjudication_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ProviderIncidentAdjudication rows are append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ProviderIncidentAdjudication_append_only"
  BEFORE UPDATE OR DELETE ON "ProviderIncidentAdjudication"
  FOR EACH ROW EXECUTE FUNCTION "provider_incident_adjudication_append_only_fn"();

-- Incident: decided exactly when an effective adjudication exists.
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_decided_has_head"
    CHECK (("status"::text IN ('CONFIRMED', 'DISMISSED')) = ("effectiveAdjudicationId" IS NOT NULL));

-- Incident: the provider's response is one trimmed text of 10..2000, and an
-- undecided incident with a response is PROVIDER_RESPONDED (never REPORTED).
ALTER TABLE "ProviderServiceIncident" ADD CONSTRAINT "Incident_response_rules"
    CHECK (
        "providerResponse" IS NULL
        OR ("providerResponse" = btrim("providerResponse")
            AND char_length("providerResponse") BETWEEN 10 AND 2000
            AND "status"::text <> 'REPORTED')
    );

-- Incident: the head moves only forward (INITIAL first, then each CORRECTION of
-- the previous head) and never back to NULL; status and the reviewed*
-- compatibility columns equal the head's decision, author, time and
-- rationale; the response is written once, and never after a decision.
CREATE FUNCTION "provider_service_incident_decision_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head record;
BEGIN
  IF NEW."effectiveAdjudicationId" IS DISTINCT FROM OLD."effectiveAdjudicationId" THEN
    IF NEW."effectiveAdjudicationId" IS NULL THEN
      RAISE EXCEPTION 'ProviderServiceIncident % decision head cannot be cleared', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."effectiveAdjudicationId" IS NOT NULL THEN
    SELECT a."kind"::text AS kind, a."decision"::text AS decision, a."supersedesAdjudicationId" AS supersedes,
           a."decidedByAdminId" AS decided_by, a."createdAt" AS created_at, a."rationale" AS rationale
      INTO head
    FROM "ProviderIncidentAdjudication" a
    WHERE a."id" = NEW."effectiveAdjudicationId" AND a."incidentId" = NEW."id";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ProviderServiceIncident % head % is not one of its adjudications', NEW."id", NEW."effectiveAdjudicationId"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."effectiveAdjudicationId" IS DISTINCT FROM OLD."effectiveAdjudicationId" THEN
      IF OLD."effectiveAdjudicationId" IS NULL AND head.kind <> 'INITIAL' THEN
        RAISE EXCEPTION 'INCIDENT_ADJUDICATION_CHANGED: first head of % must be the INITIAL decision', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."effectiveAdjudicationId" IS NOT NULL AND head.supersedes IS DISTINCT FROM OLD."effectiveAdjudicationId" THEN
        RAISE EXCEPTION 'INCIDENT_ADJUDICATION_CHANGED: % does not supersede the head % of incident %',
          NEW."effectiveAdjudicationId", OLD."effectiveAdjudicationId", NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF NEW."status"::text <> head.decision
       OR NEW."reviewedById" IS DISTINCT FROM head.decided_by
       OR NEW."reviewedAt" IS DISTINCT FROM head.created_at
       OR NEW."reviewNote" IS DISTINCT FROM head.rationale THEN
      RAISE EXCEPTION 'ProviderServiceIncident % projection does not match its effective adjudication %', NEW."id", NEW."effectiveAdjudicationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF ROW(NEW."providerResponse", NEW."providerRespondedAt", NEW."providerRespondedById")
     IS DISTINCT FROM ROW(OLD."providerResponse", OLD."providerRespondedAt", OLD."providerRespondedById") THEN
    IF OLD."providerResponse" IS NOT NULL THEN
      RAISE EXCEPTION 'INCIDENT_RESPONSE_ALREADY_SUBMITTED: incident % already has a provider response', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."effectiveAdjudicationId" IS NOT NULL THEN
      RAISE EXCEPTION 'INCIDENT_ALREADY_ADJUDICATED: incident % is decided; the response is closed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProviderServiceIncident_decision_projection"
  BEFORE UPDATE ON "ProviderServiceIncident"
  FOR EACH ROW EXECUTE FUNCTION "provider_service_incident_decision_guard_fn"();

-- Reliability review: at most one unresolved (OPEN or ACKNOWLEDGED) per
-- provider — the idempotency of "open a review at the third confirmation".
CREATE UNIQUE INDEX "ProviderReliabilityReview_one_unresolved_per_provider"
  ON "ProviderReliabilityReview"("providerId") WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');

-- Reliability review shape: who and when for each step taken, nothing for a
-- step not taken; a resolution carries its note.
ALTER TABLE "ProviderReliabilityReview" ADD CONSTRAINT "ReliabilityReview_shape"
    CHECK (
        ("acknowledgedAt" IS NULL) = ("acknowledgedById" IS NULL)
        AND ("resolvedAt" IS NULL) = ("resolvedById" IS NULL)
        AND ("status"::text = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
        AND ("status"::text <> 'ACKNOWLEDGED' OR "acknowledgedAt" IS NOT NULL)
        AND ("status"::text <> 'OPEN' OR "acknowledgedAt" IS NULL)
        AND ("status"::text = 'RESOLVED') = ("note" IS NOT NULL)
        AND ("note" IS NULL OR ("note" = btrim("note") AND char_length("note") BETWEEN 10 AND 2000))
    );

-- Reliability review lifecycle: OPEN → ACKNOWLEDGED → RESOLVED (or OPEN →
-- RESOLVED), never backwards; RESOLVED is final; what opened it and each
-- stamp, once written, never change. Never deleted.
CREATE FUNCTION "provider_reliability_review_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ProviderReliabilityReview rows are never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status"::text = 'RESOLVED' THEN
    RAISE EXCEPTION 'ProviderReliabilityReview % is resolved and final', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status"::text = 'ACKNOWLEDGED' AND NEW."status"::text = 'OPEN' THEN
    RAISE EXCEPTION 'ProviderReliabilityReview % cannot go back to OPEN', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerId" IS DISTINCT FROM OLD."providerId"
     OR NEW."triggerIncidentId" IS DISTINCT FROM OLD."triggerIncidentId"
     OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
     OR NEW."openedBySystem" IS DISTINCT FROM OLD."openedBySystem"
     OR (OLD."acknowledgedAt" IS NOT NULL AND (NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt"
                                               OR NEW."acknowledgedById" IS DISTINCT FROM OLD."acknowledgedById")) THEN
    RAISE EXCEPTION 'ProviderReliabilityReview % history cannot change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProviderReliabilityReview_lifecycle"
  BEFORE UPDATE OR DELETE ON "ProviderReliabilityReview"
  FOR EACH ROW EXECUTE FUNCTION "provider_reliability_review_guard_fn"();

-- The reliability queue: providers with two or more confirmed incidents in the
-- last 90 days, read from the projection (equal to the effective decision by
-- the trigger above). Small: confirmed incidents only.
CREATE INDEX "ProviderServiceIncident_confirmed_recent_idx"
  ON "ProviderServiceIncident"("reportedAt", "providerId") WHERE "status" = 'CONFIRMED';

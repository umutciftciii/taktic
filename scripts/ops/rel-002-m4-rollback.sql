-- REL-002 M4 rollback — undo 20261012120000_add_incident_adjudication_reliability.
--
-- For an emergency revert of the Faz 4 code to the Faz 3 release (acaf9902),
-- and ONLY while nothing Faz 4 writes exists: no adjudication, no reliability
-- review, no provider response, no decided incident, and no role carrying one
-- of the five new permissions. Once a decision is recorded there is no
-- backward schema rollback — the decision chain *is* the audit of who decided
-- what about a provider, and dropping it would erase it — and the only way
-- back is forward-fix (correct in code; a wrong decision is corrected by a
-- SUPER_ADMIN correction, never by deleting rows).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-m4-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the M3 schema (97 migrations)
-- or changes nothing. Data is not touched.
--
-- What it cannot take back: the five AdminPermission values (no DROP VALUE in
-- PostgreSQL; see the M3 rollback for why the type is not swapped). The
-- refusal below proves no role grants them, the Faz 3 code never reads them,
-- and the migration adds them with IF NOT EXISTS so a re-deploy succeeds; the
-- drift check against the Faz 3 schema reports exactly these values.
--
-- Rehearsed on a restored copy (REL-002 doc §33.12): rollback → drift against
-- acaf9902 shows only the enum values → `migrate deploy` re-applies M4.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261012120000_add_incident_adjudication_reliability'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'REL-002 M4 rollback refused: M4 is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProviderIncidentAdjudication")
     OR EXISTS (SELECT 1 FROM "ProviderReliabilityReview")
     OR EXISTS (SELECT 1 FROM "ProviderServiceIncident"
                WHERE "effectiveAdjudicationId" IS NOT NULL OR "providerResponse" IS NOT NULL
                   OR "status"::text <> 'REPORTED')
     OR EXISTS (SELECT 1 FROM "AdminRolePermission"
                WHERE "permission"::text IN ('SERVICE_INCIDENTS_READ', 'SERVICE_INCIDENTS_ADJUDICATE',
                                             'SERVICE_INCIDENTS_CORRECT', 'PROVIDER_RELIABILITY_READ',
                                             'PROVIDER_RELIABILITY_MANAGE')) THEN
    RAISE EXCEPTION 'REL-002 M4 rollback refused: Faz 4 data exists (adjudications, reviews, provider responses, decided incidents or role grants of the new permissions) — forward-fix only';
  END IF;
END;
$$;

DROP INDEX "ProviderServiceIncident_confirmed_recent_idx";

-- Reliability review.
DROP TRIGGER "ProviderReliabilityReview_lifecycle" ON "ProviderReliabilityReview";
DROP FUNCTION "provider_reliability_review_guard_fn"();
DROP TABLE "ProviderReliabilityReview";

-- Incident guards and the head.
DROP TRIGGER "ProviderServiceIncident_decision_projection" ON "ProviderServiceIncident";
DROP FUNCTION "provider_service_incident_decision_guard_fn"();
ALTER TABLE "ProviderServiceIncident" DROP CONSTRAINT "Incident_response_rules";
ALTER TABLE "ProviderServiceIncident" DROP CONSTRAINT "Incident_decided_has_head";
ALTER TABLE "ProviderServiceIncident" DROP CONSTRAINT "ProviderServiceIncident_effectiveAdjudicationId_id_fkey";

-- Adjudications.
DROP TRIGGER "ProviderIncidentAdjudication_append_only" ON "ProviderIncidentAdjudication";
DROP FUNCTION "provider_incident_adjudication_append_only_fn"();
DROP TRIGGER "ProviderIncidentAdjudication_chain" ON "ProviderIncidentAdjudication";
DROP FUNCTION "provider_incident_adjudication_chain_fn"();
DROP TABLE "ProviderIncidentAdjudication";

DROP INDEX "ProviderServiceIncident_effectiveAdjudicationId_key";
DROP INDEX "ProviderServiceIncident_providerId_reportedAt_idx";
DROP INDEX "ProviderServiceIncident_id_providerId_key";
ALTER TABLE "ProviderServiceIncident" DROP COLUMN "effectiveAdjudicationId";

DROP TYPE "ProviderReliabilityReviewStatus";
DROP TYPE "ProviderIncidentAdjudicationKind";
DROP TYPE "ProviderIncidentDecision";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261012120000_add_incident_adjudication_reliability';

COMMIT;

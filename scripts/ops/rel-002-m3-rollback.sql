-- REL-002 M3 rollback — undo 20261012090000_add_service_issue_reopen_core.
--
-- For an emergency revert of the Faz 3 code to the Faz 2 release (1ffd4bb0),
-- and ONLY while the service-issue feature has never been used: no incident,
-- no exclusion, no FAILED round, no MATCH_REVIEW request and no request with
-- more than one round. Once a customer report has opened a real Round 2 (the
-- flag was on and somebody used it) there is no backward schema rollback:
-- Round 2 is valid data the Faz 2 code cannot represent (its M2 rollback
-- refuses too), and the only way back is forward-fix — turn the flag off and
-- correct in code.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-m3-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the M2 schema (96 migrations)
-- or changes nothing. Data is not touched.
--
-- What it cannot take back: the enum values M3 added (MatchRoundStatus FAILED,
-- MatchRoundOpenedBy SERVICE_ISSUE/ADMIN, ServiceRequestStatus MATCH_REVIEW,
-- NumberedEntityType SERVICE_INCIDENT, AdminPermission
-- SERVICE_ISSUE_SETTING_WRITE). PostgreSQL has no DROP VALUE, and swapping
-- each type out from under its columns, indexes and CHECKs is a riskier
-- operation than the one it would undo. The values are unused (the refusal
-- below proves it) and the Faz 2 code never reads them, so they stay; the
-- drift check against the Faz 2 schema reports exactly these enum values and
-- nothing else.
--
-- Rehearsed on a restored copy (REL-002 doc §32.8): rollback → drift against
-- 1ffd4bb0 shows only the enum values → `migrate deploy` re-applies M3.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261012090000_add_service_issue_reopen_core'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'REL-002 M3 rollback refused: M3 is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProviderServiceIncident")
     OR EXISTS (SELECT 1 FROM "ServiceRequestProviderExclusion")
     OR EXISTS (SELECT 1 FROM "ServiceRequestMatchRound" WHERE "status"::text = 'FAILED' OR "failureIncidentId" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "ServiceRequest" WHERE "status"::text = 'MATCH_REVIEW')
     OR EXISTS (SELECT 1 FROM "ServiceRequestMatchRound" GROUP BY "requestId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'REL-002 M3 rollback refused: the service-issue flow has been used (incidents, exclusions, FAILED rounds, MATCH_REVIEW or a second round exist) — forward-fix only';
  END IF;
END;
$$;

-- The Offer INSERT backstop.
DROP TRIGGER "Offer_round_open_guard" ON "Offer";
DROP FUNCTION "offer_round_open_guard_fn"();

-- Exclusion and incident row guards.
DROP TRIGGER "ServiceRequestProviderExclusion_append_only" ON "ServiceRequestProviderExclusion";
DROP FUNCTION "service_request_provider_exclusion_append_only_fn"();
DROP TRIGGER "ProviderServiceIncident_no_delete" ON "ProviderServiceIncident";
DROP FUNCTION "provider_service_incident_no_delete_fn"();

-- The terminal-status trigger, back to M1's (status only; COMPLETED,
-- CANCELLED, EXPIRED).
DROP TRIGGER "MatchRound_terminal_status_immutable" ON "ServiceRequestMatchRound";
CREATE OR REPLACE FUNCTION "match_round_terminal_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'ServiceRequestMatchRound % is % and its status cannot change (to %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "MatchRound_terminal_status_immutable"
  BEFORE UPDATE OF "status" ON "ServiceRequestMatchRound"
  FOR EACH ROW EXECUTE FUNCTION "match_round_terminal_guard_fn"();

-- The round's failure columns and CHECKs.
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_failure_incident_only_when_failed";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_failed_shape";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "ServiceRequestMatchRound_failureIncidentId_id_fkey";
DROP INDEX "ServiceRequestMatchRound_failureIncidentId_key";
ALTER TABLE "ServiceRequestMatchRound" DROP COLUMN "failureIncidentId";

-- The two tables (exclusion first: it references the incident).
DROP TABLE "ServiceRequestProviderExclusion";
DROP TABLE "ProviderServiceIncident";
DROP TYPE "ServiceIssueEligibilityBasis";
DROP TYPE "ProviderIncidentStatus";
DROP TYPE "ServiceIssueReason";

-- The flag.
ALTER TABLE "OperationsSettings" DROP COLUMN "serviceIssueReportingEnabled";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261012090000_add_service_issue_reopen_core';

COMMIT;

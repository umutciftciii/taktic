-- REL-002 M5 rollback — undo 20261013090000_add_match_review_round_opening.
--
-- For an emergency revert of the Faz 5 code to the Faz 4 release (36c14708),
-- and ONLY while nothing Faz 5 writes exists: no staff round opening (and so
-- no ADMIN round) and no role carrying the new permission. Once a Round 4+ was
-- opened there is no backward schema rollback — the opening row is that
-- round's audit — and the only way back is forward-fix.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-m5-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the M4 schema (98 migrations)
-- or changes nothing. Data is not touched.
--
-- What it cannot take back: the MATCH_REVIEW_OPEN_ROUND AdminPermission value
-- (no DROP VALUE in PostgreSQL). The refusal below proves no role grants it,
-- the Faz 4 code never reads it, and the migration adds it with IF NOT EXISTS
-- so a re-deploy succeeds; the drift check against the Faz 4 schema reports
-- exactly this value.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261013090000_add_match_review_round_opening'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'REL-002 M5 rollback refused: M5 is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceRequestRoundOpening")
     OR EXISTS (SELECT 1 FROM "ServiceRequestMatchRound" WHERE "openedBy"::text = 'ADMIN')
     OR EXISTS (SELECT 1 FROM "AdminRolePermission" WHERE "permission"::text = 'MATCH_REVIEW_OPEN_ROUND') THEN
    RAISE EXCEPTION 'REL-002 M5 rollback refused: Faz 5 data exists (staff round openings, ADMIN rounds or role grants of the new permission) — forward-fix only';
  END IF;
END;
$$;

DROP TRIGGER "ServiceRequestRoundOpening_append_only" ON "ServiceRequestRoundOpening";
DROP FUNCTION "service_request_round_opening_append_only_fn"();
DROP TRIGGER "ServiceRequestRoundOpening_shape" ON "ServiceRequestRoundOpening";
DROP FUNCTION "service_request_round_opening_shape_fn"();
DROP TABLE "ServiceRequestRoundOpening";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261013090000_add_match_review_round_opening';

COMMIT;

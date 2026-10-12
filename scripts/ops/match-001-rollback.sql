-- MATCH-001 rollback — undo 20261014090000_add_category_delivery_model.
--
-- For an emergency revert of the MATCH-001 code to v0.2.0 (2869fc62), and ONLY
-- while the feature has never been used: every category ON_SITE and every
-- request ON_SITE. Once a REMOTE or HYBRID category exists, or a REMOTE
-- request, there is no backward schema rollback — dropping the column would
-- turn a REMOTE request into an ON_SITE one and silently re-apply location
-- filtering to it (providers who already offered would lose it) — and the
-- only way back is forward-fix.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/match-001-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the v0.2.0 schema (99
-- migrations) or changes nothing. No row is touched; both columns only ever
-- held their default.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261014090000_add_category_delivery_model'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'MATCH-001 rollback refused: the migration is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCategory" WHERE "deliveryModel"::text <> 'ON_SITE')
     OR EXISTS (SELECT 1 FROM "ServiceRequest" WHERE "deliveryMode"::text <> 'ON_SITE') THEN
    RAISE EXCEPTION 'MATCH-001 rollback refused: a REMOTE/HYBRID category or a REMOTE request exists — forward-fix only';
  END IF;
END;
$$;

DROP TRIGGER "ServiceRequest_delivery_mode_guard" ON "ServiceRequest";
DROP FUNCTION "ServiceRequest_delivery_mode_guard"();
ALTER TABLE "ServiceRequest" DROP COLUMN "deliveryMode";
ALTER TABLE "ServiceCategory" DROP COLUMN "deliveryModel";
DROP TYPE "RequestDeliveryMode";
DROP TYPE "CategoryDeliveryModel";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261014090000_add_category_delivery_model';

COMMIT;

-- OBS-ALERT-001 rollback — undo 20261031090000_add_ops_alerts.
--
-- For an emergency revert of the code to the release before it (863266bd).
-- The tables are alert history only — no business record, credit, refund or
-- notification depends on them — so dropping them loses the alert history
-- and nothing else. Take a backup first if that history matters.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/obs-alert-001-rollback.sql
--
-- Run with the API stopped (a running evaluator would write into the tables
-- being dropped). One transaction: it either leaves the database at the
-- previous schema or changes nothing.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261031090000_add_ops_alerts'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'OBS-ALERT-001 rollback refused: the migration is not applied here';
  END IF;
END;
$$;

DROP TABLE "OpsAlertDelivery";
DROP TABLE "OpsAlert";
DROP TABLE "OpsAlertEngineState";
DROP TYPE "OpsAlertDeliveryStatus";
DROP TYPE "OpsAlertChannel";
DROP TYPE "OpsAlertNoticeKind";
DROP TYPE "OpsAlertState";
DROP TYPE "OpsAlertSeverity";
DROP TYPE "OpsAlertSource";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261031090000_add_ops_alerts';

COMMIT;

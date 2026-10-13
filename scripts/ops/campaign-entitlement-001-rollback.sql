-- CAMPAIGN-ENTITLEMENT-001 rollback — undo 20261015090000_add_offer_allowances.
--
-- For an emergency revert of the allowance code to the previous main
-- (274d47a2), and ONLY while no allowance has ever been spent: the
-- OfferAllowanceUsage table is empty. Once one usage row exists the tables are
-- the financial audit of offers that were answered for free under the bounded
-- rule, and they are never dropped — the way back is then a code revert alone
-- (which returns to the old unlimited-free behaviour and leaves these tables
-- unread) or, preferably, a forward-fix.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/campaign-entitlement-001-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the 100-migration schema or
-- changes nothing. No Offer row is touched: the migration never changed one.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261015090000_add_offer_allowances'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'CAMPAIGN-ENTITLEMENT-001 rollback refused: the migration is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "OfferAllowanceUsage") THEN
    RAISE EXCEPTION 'CAMPAIGN-ENTITLEMENT-001 rollback refused: allowance usage rows exist — forward-fix (or code revert without dropping) only';
  END IF;
END;
$$;

DROP TRIGGER "OfferAllowanceUsage_append_only" ON "OfferAllowanceUsage";
DROP FUNCTION "OfferAllowanceUsage_append_only_fn"();
DROP TRIGGER "OfferAllowanceUsage_insert_guard" ON "OfferAllowanceUsage";
DROP FUNCTION "OfferAllowanceUsage_insert_guard_fn"();
DROP TABLE "OfferAllowanceUsage";
DROP TABLE "OfferAllowanceGrant";
DROP TYPE "OfferAllowanceStatus";
DROP TYPE "OfferAllowanceBenefit";
DROP TYPE "OfferAllowanceSource";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261015090000_add_offer_allowances';

COMMIT;

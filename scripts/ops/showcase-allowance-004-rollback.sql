-- SHOWCASE-ALLOWANCE-004 rollback — undo 20261018090000_add_offer_allowance_void.
--
-- For an emergency revert of the Faz 1 code to the release before it
-- (8a46f0ce), and ONLY while nothing Faz 1 writes exists: no VOID grant and no
-- role carrying the new permission. Once a grant was voided there is no
-- backward schema rollback — the void would lose its reason, its note and the
-- trigger that keeps it final — and the only way back is forward-fix.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/showcase-allowance-004-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database at the previous schema (103
-- migrations) or changes nothing. Data is not touched.
--
-- What it cannot take back: the SHOWCASE_ALLOWANCE_VOID AdminPermission value
-- (no DROP VALUE in PostgreSQL). The refusal below proves no role grants it,
-- the previous code never reads it, and the migration adds it with IF NOT
-- EXISTS so a re-deploy succeeds; the drift check against the previous schema
-- reports exactly this value.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261018090000_add_offer_allowance_void'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'SHOWCASE-ALLOWANCE-004 rollback refused: the migration is not applied here';
  END IF;
  IF EXISTS (SELECT 1 FROM "OfferAllowanceGrant" WHERE "status" = 'VOID' OR "voidedAt" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "AdminRolePermission" WHERE "permission"::text = 'SHOWCASE_ALLOWANCE_VOID') THEN
    RAISE EXCEPTION 'SHOWCASE-ALLOWANCE-004 rollback refused: a grant is VOID or a role grants the new permission — forward-fix only';
  END IF;
END;
$$;

DROP TRIGGER "OfferAllowanceGrant_guard" ON "OfferAllowanceGrant";
DROP FUNCTION "OfferAllowanceGrant_guard_fn"();

ALTER TABLE "OfferAllowanceGrant" DROP CONSTRAINT "OfferAllowanceGrant_void_note_length";
ALTER TABLE "OfferAllowanceGrant" DROP CONSTRAINT "OfferAllowanceGrant_void_shape";
ALTER TABLE "OfferAllowanceGrant" DROP COLUMN "voidNote";
ALTER TABLE "OfferAllowanceGrant" ALTER COLUMN "voidReason" TYPE TEXT USING ("voidReason"::text);
DROP TYPE "OfferAllowanceVoidReason";
ALTER TABLE "OfferAllowanceGrant"
  ADD CONSTRAINT "OfferAllowanceGrant_void_shape" CHECK (
    ("status" = 'VOID') = ("voidedAt" IS NOT NULL)
    AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidedById" IS NULL)
  );

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018090000_add_offer_allowance_void';

COMMIT;

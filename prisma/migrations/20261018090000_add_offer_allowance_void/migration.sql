-- SHOWCASE-ALLOWANCE-004 (Faz 1): voiding a vitrin run's remaining free offers.
--
-- What this adds:
--
--   * one AdminPermission value, SHOWCASE_ALLOWANCE_VOID, reserved for
--     SUPER_ADMIN by the application (no role may carry it);
--   * the OfferAllowanceVoidReason enum, and `voidReason` retyped to it (the
--     column has never been written: nothing wrote VOID before this change,
--     and the precondition below refuses to run otherwise);
--   * `voidNote`, the operator's internal note, and the widened shape CHECK:
--     all four void columns are set together or none, only with VOID;
--   * the OfferAllowanceGrant_guard trigger, which makes the grant's facts
--     immutable and VOID final:
--       - id, providerId, source, benefit, showcasePlacementId and quotaTotal
--         never change after the insert;
--       - quotaUsed never goes down;
--       - a grant is never inserted VOID;
--       - ACTIVE → VOID claims no slot in the same statement, needs something
--         left to void, and names a SUPER_ADMIN as the actor;
--       - a VOID row is never updated again and never deleted.
--
-- Additive in effect: no populated column is rewritten (the retype runs over a
-- column that is NULL on every row) and no existing row changes.
--
-- The new AdminPermission value is not used here (ADD VALUE ... IF NOT EXISTS,
-- as REL-002 M3–M5: PostgreSQL cannot drop an enum value, so the rollback
-- script leaves it, and a re-deploy after that rollback must not fail on it).
--
-- Irreversibility boundary: while no grant is VOID the objects below can be
-- dropped by hand (scripts/ops/showcase-allowance-004-rollback.sql, which
-- refuses otherwise). Once a grant is VOID there is no backward schema
-- rollback — the void would lose its reason and its guarantee — and recovery
-- is forward-fix only.

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'SHOWCASE_ALLOWANCE_VOID';

-- Precondition: nothing has written the void columns. The retype below would
-- otherwise have to invent a reason code for a row nobody explained.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OfferAllowanceGrant"
     WHERE "status" = 'VOID' OR "voidedAt" IS NOT NULL OR "voidReason" IS NOT NULL OR "voidedById" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SHOWCASE-ALLOWANCE-004: OfferAllowanceGrant already has void data; refusing to retype voidReason';
  END IF;
END;
$$;

-- CreateEnum
CREATE TYPE "OfferAllowanceVoidReason" AS ENUM ('FRAUD', 'ABUSE', 'TERMS_VIOLATION', 'OPERATOR_ERROR', 'OTHER');

-- AlterTable
ALTER TABLE "OfferAllowanceGrant"
  ALTER COLUMN "voidReason" TYPE "OfferAllowanceVoidReason" USING ("voidReason"::"OfferAllowanceVoidReason"),
  ADD COLUMN "voidNote" TEXT;

-- The void's shape: the four columns together or none, only with VOID; the
-- note a real sentence (trimmed, 10..1000 characters, as the API judges it).
ALTER TABLE "OfferAllowanceGrant" DROP CONSTRAINT "OfferAllowanceGrant_void_shape";
ALTER TABLE "OfferAllowanceGrant"
  ADD CONSTRAINT "OfferAllowanceGrant_void_shape" CHECK (
    ("status" = 'VOID') = ("voidedAt" IS NOT NULL)
    AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidedById" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidNote" IS NULL)
  ),
  ADD CONSTRAINT "OfferAllowanceGrant_void_note_length" CHECK (
    "voidNote" IS NULL OR char_length(btrim("voidNote")) BETWEEN 10 AND 1000
  );

-- The grant's facts are immutable, quotaUsed is monotonic, and VOID is final.
CREATE FUNCTION "OfferAllowanceGrant_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_role TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'OfferAllowanceGrant % must be born ACTIVE', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'OfferAllowanceGrant % is VOID; a voided grant is permanent (DELETE refused)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'VOID' THEN
    RAISE EXCEPTION 'OfferAllowanceGrant % is VOID; a voided grant is final (UPDATE refused)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."benefit" IS DISTINCT FROM OLD."benefit"
     OR NEW."showcasePlacementId" IS DISTINCT FROM OLD."showcasePlacementId"
     OR NEW."quotaTotal" IS DISTINCT FROM OLD."quotaTotal" THEN
    RAISE EXCEPTION 'OfferAllowanceGrant % identity, owner and quota are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."quotaUsed" < OLD."quotaUsed" THEN
    RAISE EXCEPTION 'OfferAllowanceGrant % quotaUsed never decreases (% -> %)', OLD."id", OLD."quotaUsed", NEW."quotaUsed"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'VOID' THEN
    IF NEW."quotaUsed" <> OLD."quotaUsed" THEN
      RAISE EXCEPTION 'OfferAllowanceGrant % cannot claim a slot and be voided in one statement', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."quotaUsed" >= OLD."quotaTotal" THEN
      RAISE EXCEPTION 'OfferAllowanceGrant % has nothing left to void', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT "role"::text INTO actor_role FROM "User" WHERE "id" = NEW."voidedById";
    IF actor_role IS DISTINCT FROM 'SUPER_ADMIN' THEN
      RAISE EXCEPTION 'OfferAllowanceGrant % can only be voided by a SUPER_ADMIN', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "OfferAllowanceGrant_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "OfferAllowanceGrant"
  FOR EACH ROW EXECUTE FUNCTION "OfferAllowanceGrant_guard_fn"();

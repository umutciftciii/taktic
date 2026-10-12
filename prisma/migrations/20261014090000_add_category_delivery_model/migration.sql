-- MATCH-001: category delivery model + location-independent remote matching.
--
-- What this adds:
--
--   * CategoryDeliveryModel (ON_SITE | REMOTE | HYBRID) and
--     ServiceCategory."deliveryModel" — how a category's service is delivered;
--   * RequestDeliveryMode (ON_SITE | REMOTE) and ServiceRequest."deliveryMode" —
--     the mode a request was created with, the authority for location matching
--     on that request for the rest of its life (every round included);
--   * ServiceRequest_delivery_mode_guard — a trigger that refuses
--       - an INSERT whose mode disagrees with its category (ON_SITE category →
--         ON_SITE only, REMOTE category → REMOTE only, HYBRID → either), and
--       - any UPDATE that changes "deliveryMode" (the snapshot is immutable;
--         a later change of the category's model never moves a request).
--
-- Backfill: both columns are added NOT NULL with the constant default
-- 'ON_SITE'. PostgreSQL (11+) records a constant default in the catalog and
-- does not rewrite the table, so every existing category and request reads
-- ON_SITE the moment the column exists — which is exactly the behaviour they
-- had — with no UPDATE, no fabricated REMOTE state and no long lock.
--
-- The guard is created after the columns, so it never sees the backfill.
-- Nothing else is rewritten; no index is added (matching filters by
-- category, not by these columns — see docs/match-001-delivery-model.md §12).
--
-- Irreversibility boundary: while every category is ON_SITE and every request
-- is ON_SITE, scripts/ops/match-001-rollback.sql can drop all of this (it
-- refuses otherwise). Once a REMOTE request exists there is no backward
-- schema rollback — dropping the column would silently turn it into an
-- ON_SITE request and re-apply location filtering to it — and recovery is
-- forward-fix only.

-- CreateEnum
CREATE TYPE "CategoryDeliveryModel" AS ENUM ('ON_SITE', 'REMOTE', 'HYBRID');

-- CreateEnum
CREATE TYPE "RequestDeliveryMode" AS ENUM ('ON_SITE', 'REMOTE');

-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN "deliveryModel" "CategoryDeliveryModel" NOT NULL DEFAULT 'ON_SITE';

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN "deliveryMode" "RequestDeliveryMode" NOT NULL DEFAULT 'ON_SITE';

-- The invariant, at the database: whatever the writer.
CREATE FUNCTION "ServiceRequest_delivery_mode_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  category_model "CategoryDeliveryModel";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."deliveryMode" IS DISTINCT FROM OLD."deliveryMode" THEN
      RAISE EXCEPTION 'ServiceRequest.deliveryMode is immutable (request %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "deliveryModel" INTO category_model
    FROM "ServiceCategory" WHERE "id" = NEW."categoryId";

  -- A missing category is the foreign key's error to raise, not this one's.
  IF category_model IS NULL THEN
    RETURN NEW;
  END IF;

  IF (category_model = 'ON_SITE' AND NEW."deliveryMode" <> 'ON_SITE')
     OR (category_model = 'REMOTE' AND NEW."deliveryMode" <> 'REMOTE') THEN
    RAISE EXCEPTION 'ServiceRequest.deliveryMode % does not match category model %',
      NEW."deliveryMode", category_model
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServiceRequest_delivery_mode_guard"
  BEFORE INSERT OR UPDATE OF "deliveryMode" ON "ServiceRequest"
  FOR EACH ROW EXECUTE FUNCTION "ServiceRequest_delivery_mode_guard"();

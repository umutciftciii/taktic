-- CAMPAIGN-CREDIT-POLICY-001 — Migration M: per-version credit policy, lot
-- policy snapshot, consumption source and manual-credit idempotency.
--
-- Additive: no DROP of data, no reset. The only DML is the explicit demo
-- backfill every row below needs, stated where it happens:
--
--   1. Every CampaignVersion (all PROMO_CREDITS, all demo) gets
--      spendPriority = PROMO_FIRST, adminDeductPolicy = PAID_ONLY, and its
--      `definition` JSON is rewritten to campaign rules schema v2 with the same
--      policy stated explicitly under `benefit.creditPolicy` (and `channel`
--      made explicit from the column when the JSON had none). The JSON and the
--      columns therefore carry one and the same snapshot, and a CHECK keeps
--      them equal from here on.
--   2. Every PromoCreditLot copies the policy of the version it was granted
--      under (through its redemption).
--   3. Every existing PromoCreditLotConsumption is an offer spend — the only
--      writer that ever existed — so it is OFFER_SPEND.
--
-- What the database guarantees on its own afterwards:
--   * a credit-producing version carries both policy columns, a non-credit
--     version carries neither, and the JSON says the same as the columns;
--   * the policy columns of a version and of a lot are never changed;
--   * a lot's policy equals its version's policy at insert;
--   * a consumption's source equals the type of the ledger row it points at,
--     and an ADMIN_DEDUCT share is never refunded or forfeited;
--   * one idempotency key names one manual ledger row, for ever.

-- CreateEnum
CREATE TYPE "CampaignCreditSpendPriority" AS ENUM ('PROMO_FIRST', 'PAID_FIRST');

-- CreateEnum
CREATE TYPE "CampaignAdminDeductPolicy" AS ENUM ('PAID_ONLY', 'ALLOW_PROMO');

-- CreateEnum
CREATE TYPE "PromoConsumptionSource" AS ENUM ('OFFER_SPEND', 'ADMIN_DEDUCT');

-- ───────────────────────────── CampaignVersion ─────────────────────────────

ALTER TABLE "CampaignVersion" ADD COLUMN "spendPriority" "CampaignCreditSpendPriority",
ADD COLUMN "adminDeductPolicy" "CampaignAdminDeductPolicy";

-- Demo backfill (1): columns and the v2 JSON together, one statement.
UPDATE "CampaignVersion"
SET
  "spendPriority" = 'PROMO_FIRST',
  "adminDeductPolicy" = 'PAID_ONLY',
  "definition" = jsonb_set(
    "definition"
      || jsonb_build_object('schemaVersion', 2)
      || CASE WHEN "definition" ? 'channel' THEN '{}'::jsonb ELSE jsonb_build_object('channel', "channel"::text) END,
    '{benefit,creditPolicy}',
    '{"spendPriority": "PROMO_FIRST", "adminDeductPolicy": "PAID_ONLY"}'::jsonb,
    true
  )
WHERE "benefitType" = 'PROMO_CREDITS';

-- Both or neither, and exactly when the benefit produces credit.
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_credit_policy_matches_benefit"
  CHECK (("spendPriority" IS NULL) = ("adminDeductPolicy" IS NULL)
     AND ("benefitType" = 'PROMO_CREDITS') = ("spendPriority" IS NOT NULL));

-- The JSON snapshot and the denormalised columns say the same thing.
ALTER TABLE "CampaignVersion" ADD CONSTRAINT "CampaignVersion_credit_policy_matches_definition"
  CHECK (("definition" -> 'benefit' -> 'creditPolicy' ->> 'spendPriority') IS NOT DISTINCT FROM "spendPriority"::text
     AND ("definition" -> 'benefit' -> 'creditPolicy' ->> 'adminDeductPolicy') IS NOT DISTINCT FROM "adminDeductPolicy"::text);

-- ───────────────────────────── PromoCreditLot ─────────────────────────────

ALTER TABLE "PromoCreditLot" ADD COLUMN "spendPriority" "CampaignCreditSpendPriority",
ADD COLUMN "adminDeductPolicy" "CampaignAdminDeductPolicy";

-- Demo backfill (2): the policy of the version each lot was granted under.
UPDATE "PromoCreditLot" l
SET "spendPriority" = v."spendPriority", "adminDeductPolicy" = v."adminDeductPolicy"
FROM "CampaignRedemption" r
JOIN "CampaignVersion" v ON v."id" = r."campaignVersionId"
WHERE r."id" = l."redemptionId";

ALTER TABLE "PromoCreditLot" ALTER COLUMN "spendPriority" SET NOT NULL,
ALTER COLUMN "adminDeductPolicy" SET NOT NULL;

-- ─────────────────────────── PromoCreditLotConsumption ───────────────────────────

-- Demo backfill (3) through the default, which is then dropped: from here on
-- every writer names the source.
ALTER TABLE "PromoCreditLotConsumption" ADD COLUMN "source" "PromoConsumptionSource" NOT NULL DEFAULT 'OFFER_SPEND';
ALTER TABLE "PromoCreditLotConsumption" ALTER COLUMN "source" DROP DEFAULT;

-- An admin deduction is final: its promo share is never refunded or forfeited.
ALTER TABLE "PromoCreditLotConsumption" ADD CONSTRAINT "PromoCreditLotConsumption_admin_deduct_final"
  CHECK ("source" <> 'ADMIN_DEDUCT' OR "status" = 'CONSUMED');

-- ─────────────────────────── ManualCreditOperation ───────────────────────────

-- CreateTable
CREATE TABLE "ManualCreditOperation" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "requestedCredits" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualCreditOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualCreditOperation_idempotencyKey_key" ON "ManualCreditOperation"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ManualCreditOperation_transactionId_key" ON "ManualCreditOperation"("transactionId");

-- CreateIndex
CREATE INDEX "ManualCreditOperation_providerId_createdAt_idx" ON "ManualCreditOperation"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualCreditOperation_actorId_idx" ON "ManualCreditOperation"("actorId");

-- AddForeignKey
ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_manual_type"
  CHECK ("type" IN ('ADMIN_GRANT', 'ADMIN_DEDUCT'));
ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_requested_positive"
  CHECK ("requestedCredits" >= 1);
ALTER TABLE "ManualCreditOperation" ADD CONSTRAINT "ManualCreditOperation_key_shape"
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{16,128}$');

-- ───────────────────────────── triggers ─────────────────────────────

-- Immutability: none of the columns named by the trigger's arguments may change.
CREATE FUNCTION "refuse_immutable_column_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i integer;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    IF (to_jsonb(NEW) -> TG_ARGV[i]) IS DISTINCT FROM (to_jsonb(OLD) -> TG_ARGV[i]) THEN
      RAISE EXCEPTION '%.% is written on insert and never changed', TG_TABLE_NAME, TG_ARGV[i]
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CampaignVersion_credit_policy_immutable"
  BEFORE UPDATE OF "spendPriority", "adminDeductPolicy", "benefitType" ON "CampaignVersion"
  FOR EACH ROW EXECUTE FUNCTION "refuse_immutable_column_change"('spendPriority', 'adminDeductPolicy', 'benefitType');

CREATE TRIGGER "PromoCreditLot_credit_policy_immutable"
  BEFORE UPDATE OF "spendPriority", "adminDeductPolicy", "redemptionId" ON "PromoCreditLot"
  FOR EACH ROW EXECUTE FUNCTION "refuse_immutable_column_change"('spendPriority', 'adminDeductPolicy', 'redemptionId');

CREATE TRIGGER "PromoCreditLotConsumption_source_immutable"
  BEFORE UPDATE OF "source", "creditTransactionId", "lotId" ON "PromoCreditLotConsumption"
  FOR EACH ROW EXECUTE FUNCTION "refuse_immutable_column_change"('source', 'creditTransactionId', 'lotId');

-- A lot's policy is its version's policy, by construction.
CREATE FUNCTION "promo_lot_policy_matches_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_spend "CampaignCreditSpendPriority";
  v_deduct "CampaignAdminDeductPolicy";
BEGIN
  SELECT v."spendPriority", v."adminDeductPolicy" INTO v_spend, v_deduct
  FROM "CampaignRedemption" r
  JOIN "CampaignVersion" v ON v."id" = r."campaignVersionId"
  WHERE r."id" = NEW."redemptionId";
  IF v_spend IS NULL OR v_deduct IS NULL
     OR NEW."spendPriority" IS DISTINCT FROM v_spend
     OR NEW."adminDeductPolicy" IS DISTINCT FROM v_deduct THEN
    RAISE EXCEPTION 'PromoCreditLot credit policy must equal the policy of its redemption''s campaign version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PromoCreditLot_credit_policy_matches_version"
  BEFORE INSERT ON "PromoCreditLot"
  FOR EACH ROW EXECUTE FUNCTION "promo_lot_policy_matches_version"();

-- A consumption's source is the type of the debit it was taken for.
CREATE FUNCTION "promo_consumption_source_matches_debit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_type text;
BEGIN
  SELECT t."type"::text INTO t_type FROM "ProviderCreditTransaction" t WHERE t."id" = NEW."creditTransactionId";
  IF t_type IS DISTINCT FROM NEW."source"::text THEN
    RAISE EXCEPTION 'PromoCreditLotConsumption source % does not match its ledger row type %', NEW."source", t_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PromoCreditLotConsumption_source_matches_debit"
  BEFORE INSERT ON "PromoCreditLotConsumption"
  FOR EACH ROW EXECUTE FUNCTION "promo_consumption_source_matches_debit"();

-- A manual operation record names exactly its own ledger row, and is append-only.
CREATE FUNCTION "manual_credit_operation_matches_ledger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  expected_amount integer;
BEGIN
  -- Computed first: inside an IF condition PL/pgSQL would read a CASE's THEN as the IF's own.
  expected_amount := CASE WHEN NEW."type" = 'ADMIN_DEDUCT' THEN -NEW."requestedCredits" ELSE NEW."requestedCredits" END;
  SELECT "providerId", "type", "amount", "createdById" INTO t
  FROM "ProviderCreditTransaction" WHERE "id" = NEW."transactionId";
  IF NOT FOUND
     OR t."providerId" <> NEW."providerId"
     OR t."type" <> NEW."type"
     OR t."createdById" IS DISTINCT FROM NEW."actorId"
     OR t."amount" <> expected_amount THEN
    RAISE EXCEPTION 'ManualCreditOperation does not match its ledger row'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ManualCreditOperation_matches_ledger"
  BEFORE INSERT ON "ManualCreditOperation"
  FOR EACH ROW EXECUTE FUNCTION "manual_credit_operation_matches_ledger"();

CREATE FUNCTION "refuse_manual_credit_operation_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ManualCreditOperation is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ManualCreditOperation_append_only"
  BEFORE UPDATE OR DELETE ON "ManualCreditOperation"
  FOR EACH ROW EXECUTE FUNCTION "refuse_manual_credit_operation_change"();

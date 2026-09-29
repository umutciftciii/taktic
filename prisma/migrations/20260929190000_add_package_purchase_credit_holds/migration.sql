-- API-HARDENING-001: a captured payment whose credit could not be delivered
-- because it would pass the ledger's integer column. Additive only: a new enum
-- and a new table; no existing row is read or written, nothing is backfilled.

-- CreateEnum
CREATE TYPE "PackagePurchaseCreditHoldStatus" AS ENUM ('OPEN', 'SETTLED', 'REFUND_REPORTED');

-- CreateTable
CREATE TABLE "PackagePurchaseCreditHold" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "providerOrderId" TEXT NOT NULL,
    "chargedAmountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "creditAmount" INTEGER NOT NULL,
    "balanceAtOpen" INTEGER NOT NULL,
    "openedEventId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refusedDeliveries" INTEGER NOT NULL DEFAULT 1,
    "lastRefusedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PackagePurchaseCreditHoldStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedEventId" TEXT,
    "creditTransactionId" TEXT,

    CONSTRAINT "PackagePurchaseCreditHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchaseCreditHold_purchaseId_key" ON "PackagePurchaseCreditHold"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePurchaseCreditHold_creditTransactionId_key" ON "PackagePurchaseCreditHold"("creditTransactionId");

-- CreateIndex
CREATE INDEX "PackagePurchaseCreditHold_status_openedAt_idx" ON "PackagePurchaseCreditHold"("status", "openedAt");

-- CreateIndex
CREATE INDEX "PackagePurchaseCreditHold_providerId_status_idx" ON "PackagePurchaseCreditHold"("providerId", "status");

-- AddForeignKey
ALTER TABLE "PackagePurchaseCreditHold" ADD CONSTRAINT "PackagePurchaseCreditHold_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePurchaseCreditHold" ADD CONSTRAINT "PackagePurchaseCreditHold_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePurchaseCreditHold" ADD CONSTRAINT "PackagePurchaseCreditHold_openedEventId_fkey" FOREIGN KEY ("openedEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePurchaseCreditHold" ADD CONSTRAINT "PackagePurchaseCreditHold_resolvedEventId_fkey" FOREIGN KEY ("resolvedEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePurchaseCreditHold" ADD CONSTRAINT "PackagePurchaseCreditHold_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One cause today, stated so a row with another cannot be written by mistake.
ALTER TABLE "PackagePurchaseCreditHold"
  ADD CONSTRAINT "PackagePurchaseCreditHold_reason_known" CHECK ("reason" = 'CREDIT_BALANCE_LIMIT_EXCEEDED'),
  ADD CONSTRAINT "PackagePurchaseCreditHold_amounts_positive" CHECK (
    "creditAmount" > 0 AND "chargedAmountMinor" >= 0 AND "refusedDeliveries" >= 1
  ),
  -- The status and its resolution travel together: an OPEN hold carries no
  -- resolution, a SETTLED one names the event and the ledger row that
  -- delivered the credit, a REFUND_REPORTED one names the reversal event and
  -- no ledger row.
  ADD CONSTRAINT "PackagePurchaseCreditHold_resolution_matches_status" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedEventId" IS NULL AND "creditTransactionId" IS NULL)
    OR ("status" = 'SETTLED' AND "resolvedAt" IS NOT NULL AND "resolvedEventId" IS NOT NULL AND "creditTransactionId" IS NOT NULL)
    OR ("status" = 'REFUND_REPORTED' AND "resolvedAt" IS NOT NULL AND "resolvedEventId" IS NOT NULL AND "creditTransactionId" IS NULL)
  );

-- Never deleted; closed exactly once; identity columns never rewritten.
CREATE FUNCTION "PackagePurchaseCreditHold_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PackagePurchaseCreditHold rows are never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'PackagePurchaseCreditHold % is closed', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseId" IS DISTINCT FROM OLD."purchaseId"
    OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."providerOrderId" IS DISTINCT FROM OLD."providerOrderId"
    OR NEW."chargedAmountMinor" IS DISTINCT FROM OLD."chargedAmountMinor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."creditAmount" IS DISTINCT FROM OLD."creditAmount"
    OR NEW."balanceAtOpen" IS DISTINCT FROM OLD."balanceAtOpen"
    OR NEW."openedEventId" IS DISTINCT FROM OLD."openedEventId"
    OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'PackagePurchaseCreditHold identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PackagePurchaseCreditHold_guard"
  BEFORE UPDATE OR DELETE ON "PackagePurchaseCreditHold"
  FOR EACH ROW EXECUTE FUNCTION "PackagePurchaseCreditHold_guard_fn"();

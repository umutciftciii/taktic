-- BUG-OFFER-REFUND-ACCEPT-001: an offer whose credit was refunded is charged
-- again when it is accepted, and that charge can itself be refunded once (a
-- cancel of the matched request with REFUND).
--
-- Additive only: four nullable columns, no backfill. Offers accepted after a
-- refund before this release keep what they have; nothing here guesses a
-- charge that was never taken.

ALTER TABLE "Offer"
  ADD COLUMN "creditRechargeTransactionId" TEXT,
  ADD COLUMN "creditRechargedAt" TIMESTAMP(3),
  ADD COLUMN "creditRechargeRefundedTransactionId" TEXT,
  ADD COLUMN "creditRechargeRefundedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Offer_creditRechargeTransactionId_key" ON "Offer"("creditRechargeTransactionId");
CREATE UNIQUE INDEX "Offer_creditRechargeRefundedTransactionId_key" ON "Offer"("creditRechargeRefundedTransactionId");

-- Each id travels with its timestamp; a recharge refund needs a recharge, and
-- a recharge needs the refund it answers.
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_recharge_pair_check"
    CHECK (("creditRechargeTransactionId" IS NULL) = ("creditRechargedAt" IS NULL)),
  ADD CONSTRAINT "Offer_recharge_refund_pair_check"
    CHECK (("creditRechargeRefundedTransactionId" IS NULL) = ("creditRechargeRefundedAt" IS NULL)),
  ADD CONSTRAINT "Offer_recharge_refund_requires_recharge_check"
    CHECK ("creditRechargeRefundedTransactionId" IS NULL OR "creditRechargeTransactionId" IS NOT NULL),
  ADD CONSTRAINT "Offer_recharge_requires_refund_check"
    CHECK ("creditRechargeTransactionId" IS NULL OR "creditRefundedTransactionId" IS NOT NULL);

-- The ledger's own backstops, beside "ProviderCreditTransaction_one_refund_per_offer"
-- (which stays scoped to referenceType 'Offer' and is untouched).
CREATE UNIQUE INDEX "ProviderCreditTransaction_one_recharge_per_offer"
  ON "ProviderCreditTransaction" ("referenceId")
  WHERE "type" = 'OFFER_SPEND' AND "referenceType" = 'OfferRecharge';

CREATE UNIQUE INDEX "ProviderCreditTransaction_one_recharge_refund_per_offer"
  ON "ProviderCreditTransaction" ("referenceId")
  WHERE "type" = 'OFFER_REFUND' AND "referenceType" = 'OfferRecharge';

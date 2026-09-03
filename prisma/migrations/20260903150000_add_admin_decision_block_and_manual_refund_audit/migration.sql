-- Additive only. Nothing here reads, rewrites or refunds an existing row.

-- Why an offer's refund eligibility was closed by something other than a
-- customer view.
--
-- A separate fact from `viewedAt`, and stored separately, because writing a
-- `viewedAt` the customer never earned would put a falsehood in the database:
-- the provider's panel, the admin timeline and every future reader would be
-- told a customer opened an offer nobody opened.
CREATE TYPE "OfferRefundBlockReason" AS ENUM ('ADMIN_CUSTOMER_DECISION');

ALTER TABLE "Offer" ADD COLUMN "refundBlockedAt" TIMESTAMP(3);
ALTER TABLE "Offer" ADD COLUMN "refundBlockedReason" "OfferRefundBlockReason";

-- Every existing row takes NULL, which is "nothing has closed this offer's
-- eligibility". For an offer outside the 48-hour policy that changes nothing at
-- all; for one inside it, the worker's other conditions still decide.
CREATE INDEX "Offer_refundBlockedAt_idx" ON "Offer" ("refundBlockedAt");

-- The mandatory record of an administrator refunding a credit by hand.
--
-- Written in the same transaction as the ledger row and the offer update, so a
-- manual refund with no operator's name on it cannot exist. `performedById` is
-- NOT NULL for the same reason.
CREATE TABLE "ManualOfferRefundAudit" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "creditAmount" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "performedById" TEXT NOT NULL,
    "creditTransactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualOfferRefundAudit_pkey" PRIMARY KEY ("id")
);

-- One manual refund per offer, ever. A UNIQUE rather than a plain index: this
-- is a second, independent database-level bar against paying one offer twice,
-- beside "ProviderCreditTransaction_one_refund_per_offer" on the ledger.
CREATE UNIQUE INDEX "ManualOfferRefundAudit_offerId_key" ON "ManualOfferRefundAudit" ("offerId");
-- One audit row per ledger row, so the money and its justification are each
-- other's counterpart rather than two rows a reader has to correlate.
CREATE UNIQUE INDEX "ManualOfferRefundAudit_creditTransactionId_key" ON "ManualOfferRefundAudit" ("creditTransactionId");
CREATE INDEX "ManualOfferRefundAudit_providerId_idx" ON "ManualOfferRefundAudit" ("providerId");
CREATE INDEX "ManualOfferRefundAudit_performedById_idx" ON "ManualOfferRefundAudit" ("performedById");
CREATE INDEX "ManualOfferRefundAudit_createdAt_idx" ON "ManualOfferRefundAudit" ("createdAt");

-- RESTRICT throughout, which is the default and is wanted here: an audit row
-- must not disappear because somebody deleted the operator, the provider or the
-- offer it accounts for.
ALTER TABLE "ManualOfferRefundAudit" ADD CONSTRAINT "ManualOfferRefundAudit_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualOfferRefundAudit" ADD CONSTRAINT "ManualOfferRefundAudit_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualOfferRefundAudit" ADD CONSTRAINT "ManualOfferRefundAudit_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualOfferRefundAudit" ADD CONSTRAINT "ManualOfferRefundAudit_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "ProviderCreditTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

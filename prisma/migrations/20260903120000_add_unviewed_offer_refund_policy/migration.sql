-- Additive only. Nothing here reads, rewrites or refunds an existing row.

-- Which offers the 48-hour unviewed-offer refund rule governs.
--
-- Every row that exists when this runs takes the DEFAULT false and is therefore
-- permanently outside the new policy. That is the intent, not a side effect:
-- providers whose offers were sold under the previous terms are not owed a
-- retroactive credit, and paying one out would be inventing a liability. The
-- flag is written true only by the offer-creation path deployed with this
-- change, so "in scope" is a fact the row carries rather than something a
-- worker infers by comparing submittedAt against a deploy timestamp it cannot
-- know.
ALTER TABLE "Offer" ADD COLUMN "unviewedRefundPolicy" BOOLEAN NOT NULL DEFAULT false;

-- The worker's candidate query, in its own selectivity order.
CREATE INDEX "Offer_unviewedRefundPolicy_viewedAt_submittedAt_idx"
  ON "Offer" ("unviewedRefundPolicy", "viewedAt", "submittedAt");

-- One refund per offer, enforced by the database rather than by whichever
-- caller happens to run next.
--
-- The application already guards this twice (a conditional UPDATE on the
-- offer's null refund columns, inside a Serializable transaction), but both
-- guards live in code that a retry, a second worker or a later refund path
-- could get wrong. This index cannot be got wrong: a second OFFER_REFUND row
-- pointing at the same offer fails to insert, which aborts the transaction that
-- was about to double-pay.
--
-- Partial, so it constrains nothing but offer refunds: OFFER_SPEND rows, and
-- every ledger type with a NULL referenceId, are untouched.
CREATE UNIQUE INDEX "ProviderCreditTransaction_one_refund_per_offer"
  ON "ProviderCreditTransaction" ("referenceId")
  WHERE "type" = 'OFFER_REFUND' AND "referenceType" = 'Offer';

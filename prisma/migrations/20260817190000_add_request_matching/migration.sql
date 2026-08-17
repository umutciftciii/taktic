-- Request matching lifecycle: a request can be matched to exactly one offer.
--
-- Fully additive: no column or enum value is renamed or dropped, so existing
-- rows, admin filters and the refund scan keep working unchanged. Offers
-- rejected before this migration keep a NULL rejectionReason, which is exactly
-- how a hand-rejected offer is represented — their refund behaviour does not
-- change.

-- 1) Why an offer was rejected. Only the automatic reason is modelled; NULL
--    stays the representation of "the customer rejected it by hand".
CREATE TYPE "OfferRejectionReason" AS ENUM ('COMPETITOR_ACCEPTED');

-- 2) New lifecycle states. SUBMITTED and IN_REVIEW keep their names and meaning
--    (the moderation phase); these are added alongside them.
--
--    PostgreSQL allows ADD VALUE inside a transaction as long as the new value
--    is not used in the same transaction — nothing below writes them.
ALTER TYPE "ServiceRequestStatus" ADD VALUE 'MATCHED';
ALTER TYPE "ServiceRequestStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "ServiceRequestStatus" ADD VALUE 'EXPIRED';

-- 3) Columns
ALTER TABLE "Offer" ADD COLUMN     "rejectionReason" "OfferRejectionReason";

ALTER TABLE "ServiceRequest" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "matchedOfferId" TEXT;

-- 4) Indexes
CREATE INDEX "Offer_rejectionReason_idx" ON "Offer"("rejectionReason");

CREATE UNIQUE INDEX "ServiceRequest_matchedOfferId_key" ON "ServiceRequest"("matchedOfferId");

CREATE INDEX "ServiceRequest_status_submittedAt_idx" ON "ServiceRequest"("status", "submittedAt");

ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_matchedOfferId_fkey" FOREIGN KEY ("matchedOfferId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5) Fail loudly instead of silently skipping the backstop.
--
--    The partial unique index below cannot be created if any request already
--    has more than one accepted offer. Postgres would report that as an opaque
--    index-build error, so check first and say exactly which requests are the
--    problem — an operator has to decide which offer wins before migrating.
DO $$
DECLARE
  duplicated TEXT;
BEGIN
  SELECT string_agg("requestId", ', ' ORDER BY "requestId")
    INTO duplicated
    FROM (
      SELECT "requestId"
        FROM "Offer"
       WHERE "status" = 'ACCEPTED'
       GROUP BY "requestId"
      HAVING COUNT(*) > 1
    ) AS conflicting;

  IF duplicated IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration aborted: these requests already have more than one accepted offer: %. Resolve them (keep one ACCEPTED per request) before migrating.',
      duplicated;
  END IF;
END $$;

-- 6) Database-level backstop for "one accepted offer per request".
--
--    Prisma cannot express a partial unique index in schema.prisma, so it is
--    declared here in raw SQL and documented on the Offer model. The accept
--    cascade already guards the transition with a conditional update; this
--    makes a second winner unrepresentable even if that guard is bypassed.
CREATE UNIQUE INDEX "Offer_one_accepted_per_request"
  ON "Offer"("requestId")
  WHERE "status" = 'ACCEPTED';

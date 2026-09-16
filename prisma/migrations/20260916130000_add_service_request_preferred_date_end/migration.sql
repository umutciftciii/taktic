-- The customer's preferred date becomes a range. `preferredDate` keeps its
-- meaning as the first day; this column is the last day. Additive and nullable:
-- no backfill, and every existing row reads as a single-day range.
ALTER TABLE "ServiceRequest" ADD COLUMN "preferredDateEnd" TIMESTAMP(3);

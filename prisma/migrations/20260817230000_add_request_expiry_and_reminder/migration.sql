-- Approval clock for the request expiry and reminder schedulers.
--
-- Fully additive: two nullable columns and two indexes. No enum value, column
-- or constraint is renamed or dropped, and no row is rewritten — applying this
-- migration changes no behaviour on its own, because both schedulers default to
-- disabled and both skip rows whose approvedAt is NULL.
--
-- Deliberately NOT backfilled. Requests approved before this column existed
-- have no trustworthy approval time: submittedAt is when the customer sent the
-- request, and moderatedAt is rewritten by every later moderation edit, so
-- either one would silently expire requests on a fabricated clock. NULL is the
-- honest representation, and the schedulers never pick those rows up.

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateIndex
-- Expiry scan: status = 'APPROVED' AND "approvedAt" <= cutoff.
CREATE INDEX "ServiceRequest_status_approvedAt_idx" ON "ServiceRequest"("status", "approvedAt");

-- CreateIndex
-- Reminder scan: the same window narrowed to unclaimed rows. reminderSentAt
-- comes before approvedAt because it is the equality predicate (IS NULL) and
-- approvedAt the range one.
CREATE INDEX "ServiceRequest_status_reminderSentAt_approvedAt_idx" ON "ServiceRequest"("status", "reminderSentAt", "approvedAt");

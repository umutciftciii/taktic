-- Additive only. No existing offer changes scope, no credit moves, and nothing
-- here reads or rewrites a ledger row.

-- ─────────────────────────── the operations setting ──────────────────────────
--
-- One row, forever, by the same construction "CompanySettings" uses. Nothing is
-- seeded: the absence of a row means "the product default", which is the 48
-- hours every offer in this database was already sold under, so the platform
-- behaves identically before and after an operator first opens the screen.
CREATE TABLE "OperationsSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "unviewedOfferRefundWindowHours" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "OperationsSettings_pkey" PRIMARY KEY ("id")
);

-- "Exactly one row" as a database guarantee rather than an application habit.
ALTER TABLE "OperationsSettings"
    ADD CONSTRAINT "OperationsSettings_singleton_check" CHECK ("id" = 'singleton');

-- The bound the DTO also enforces, restated where it cannot be bypassed. A
-- non-positive window would refund an offer the moment it was sent; a window
-- past 720 hours (30 days) is not a refund promise any provider can plan on.
ALTER TABLE "OperationsSettings"
    ADD CONSTRAINT "OperationsSettings_unviewed_window_range_check"
    CHECK ("unviewedOfferRefundWindowHours" BETWEEN 1 AND 720);

CREATE INDEX "OperationsSettings_updatedById_idx" ON "OperationsSettings"("updatedById");

ALTER TABLE "OperationsSettings"
    ADD CONSTRAINT "OperationsSettings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────────────────── the audit trail of changes ────────────────────────
--
-- The settings row above only ever holds the current answer. A commercial term
-- that decides refunds has to be answerable after the fact, so every change is
-- recorded as its own row: old value, new value, operator, moment.
CREATE TABLE "OperationsSettingsChange" (
    "id" TEXT NOT NULL,
    "setting" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationsSettingsChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperationsSettingsChange_setting_createdAt_idx"
    ON "OperationsSettingsChange"("setting", "createdAt");
CREATE INDEX "OperationsSettingsChange_changedById_idx"
    ON "OperationsSettingsChange"("changedById");

-- RESTRICT, the default: an audit row must not disappear because somebody
-- deleted the operator it names. "changedById" is NOT NULL for the same reason.
ALTER TABLE "OperationsSettingsChange"
    ADD CONSTRAINT "OperationsSettingsChange_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────── the per-offer snapshot ────────────────────────────
--
-- The window an offer was sold under, and the exact moment its credit becomes
-- refundable. Written once, when the offer is created, and never recomputed.
ALTER TABLE "Offer" ADD COLUMN "unviewedRefundWindowHours" INTEGER;
ALTER TABLE "Offer" ADD COLUMN "unviewedRefundEligibleAt" TIMESTAMP(3);

-- The one backfill, and it changes nobody's rights.
--
-- An in-policy offer written before this migration was already governed by a
-- fixed 48 hours computed from its own "submittedAt". This writes that same
-- moment down instead of leaving the worker to recompute it from a constant
-- that is about to become configurable — so an operator setting 72 hours
-- tomorrow cannot retroactively extend a promise already made at 48.
--
-- Deliberately scoped to "unviewedRefundPolicy" = true. An offer sold under the
-- previous terms carries false, gets no schedule, and stays permanently outside
-- the policy: this migration does not widen the population that can be paid.
UPDATE "Offer"
SET "unviewedRefundWindowHours" = 48,
    "unviewedRefundEligibleAt" = "submittedAt" + INTERVAL '48 hours'
WHERE "unviewedRefundPolicy" = true
  AND "unviewedRefundEligibleAt" IS NULL;

-- The worker's candidate query after the snapshot: policy offers only, unviewed
-- only, ordered by the moment each one becomes eligible.
CREATE INDEX "Offer_refund_schedule_idx"
  ON "Offer" ("unviewedRefundPolicy", "viewedAt", "unviewedRefundEligibleAt");

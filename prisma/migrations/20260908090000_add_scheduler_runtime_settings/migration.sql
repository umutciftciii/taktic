-- Additive only. Four boolean columns on the settings row that already exists,
-- and nothing else: no table is created, no row is written, no ledger is read,
-- and no scheduler starts because of this migration.

-- ───────────────────── the four background jobs, as settings ─────────────────
--
-- Each column is the single source of truth for whether one background job may
-- act. They were environment flags until now, which meant the answer to "is the
-- refund worker on?" lived in a file only a deploy could change and only a
-- shell could read. It is a runtime operations decision, so it lives with the
-- other runtime operations decisions — on the row a super admin maintains, with
-- the same audit trail behind it.
--
-- DEFAULT false, NOT NULL, and no backfill. That is the whole safety story of
-- this migration: a deployment that already had every flag set to "true" comes
-- up with all four jobs OFF, because a job that moves money, expires a request
-- or mails a customer must be turned on by a person who is watching — never by
-- a migration that happened to run at three in the morning.
--
-- An existing "OperationsSettings" row therefore gains four false columns; a
-- deployment with no row at all reads "no row" as false as well. Both paths
-- land in the same place: nothing runs until somebody says so.
ALTER TABLE "OperationsSettings"
    ADD COLUMN "entitlementRenewalSchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OperationsSettings"
    ADD COLUMN "unviewedOfferRefundSchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OperationsSettings"
    ADD COLUMN "requestExpirySchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OperationsSettings"
    ADD COLUMN "requestReminderSchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;

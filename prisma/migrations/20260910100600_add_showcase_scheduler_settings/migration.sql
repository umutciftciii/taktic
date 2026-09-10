-- Vitrin phase two, step 7 of 7: two more switches on the operations settings
-- row, and nothing else.
--
-- The exact shape of add_scheduler_runtime_settings: two boolean columns,
-- NOT NULL, DEFAULT false, no backfill needed because the default is the
-- correct answer for the one existing row and for a deployment with no row at
-- all.
--
-- **This migration starts nothing.** Both jobs are off until a super admin
-- opens the scheduler screen and switches them on, and both are read
-- fail-closed on every tick: no row, an unreadable row or a false column all
-- mean the job does nothing.

-- AlterTable
ALTER TABLE "OperationsSettings"
  ADD COLUMN "showcaseLeadSlaSchedulerEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showcasePlacementExpirySchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;

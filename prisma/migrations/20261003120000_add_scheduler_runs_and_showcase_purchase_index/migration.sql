-- ADMIN-BACKEND-TRUTH-001. Additive only: two enums, one new table, one new
-- index on an existing table. No existing column, row or constraint changes,
-- and nothing is backfilled — runs from before this migration are unknown.

-- OPS-SCHEDULER-RUN-PERSISTENCE-001 ---------------------------------------

-- CreateEnum
CREATE TYPE "SchedulerRunTrigger" AS ENUM ('SCHEDULER', 'MANUAL');

-- CreateEnum
CREATE TYPE "SchedulerRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "SchedulerRun" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "trigger" "SchedulerRunTrigger" NOT NULL DEFAULT 'SCHEDULER',
    "status" "SchedulerRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "summary" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchedulerRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchedulerRun_jobKey_present" CHECK (length("jobKey") BETWEEN 1 AND 64),
    -- A run has an end exactly when it is no longer running, and it cannot end
    -- before it started.
    CONSTRAINT "SchedulerRun_finished_matches_status" CHECK (
      ("status" = 'RUNNING' AND "finishedAt" IS NULL)
      OR ("status" <> 'RUNNING' AND "finishedAt" IS NOT NULL AND "finishedAt" >= "startedAt")
    ),
    -- An error class only on a failed run.
    CONSTRAINT "SchedulerRun_error_only_on_failure" CHECK (
      "errorCode" IS NULL OR "status" = 'FAILED'
    ),
    CONSTRAINT "SchedulerRun_text_bounded" CHECK (
      ("summary" IS NULL OR length("summary") <= 1000)
      AND ("errorCode" IS NULL OR length("errorCode") <= 120)
    )
);

-- CreateIndex
CREATE INDEX "SchedulerRun_jobKey_startedAt_idx" ON "SchedulerRun"("jobKey", "startedAt" DESC);

-- History, not a slot. A row is closed exactly once — RUNNING to SUCCESS or
-- FAILED, its identity unchanged — and never deleted, so a FAILED run cannot be
-- overwritten by a later one. TRUNCATE, which only test harnesses issue, does
-- not fire row triggers.
CREATE FUNCTION "scheduler_run_guard_fn"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SchedulerRun rows are append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'RUNNING'
     OR NEW."status" = 'RUNNING'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."jobKey" IS DISTINCT FROM OLD."jobKey"
     OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'A SchedulerRun is closed once, from RUNNING, and nothing else on it changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SchedulerRun_guard"
  BEFORE UPDATE OR DELETE ON "SchedulerRun"
  FOR EACH ROW EXECUTE FUNCTION "scheduler_run_guard_fn"();

-- API-SHOWCASE-PACKAGE-PURCHASES-FILTER-001 -------------------------------

-- CreateIndex
CREATE INDEX "PackagePurchase_showcasePackageId_createdAt_idx" ON "PackagePurchase"("showcasePackageId", "createdAt");

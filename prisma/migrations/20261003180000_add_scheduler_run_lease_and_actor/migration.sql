-- ADMIN-BACKEND-TRUTH-002. Additive: two nullable columns on SchedulerRun, an
-- FK, two indexes, one CHECK that every existing row already satisfies (all
-- rows are SCHEDULER runs with no actor), and the row guard re-created to also
-- allow a heartbeat. No existing row changes and nothing is backfilled: rows
-- written before this migration keep heartbeatAt and actorId NULL.

-- AlterTable
ALTER TABLE "SchedulerRun" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SchedulerRun_actorId_idx" ON "SchedulerRun"("actorId");

-- AddForeignKey
ALTER TABLE "SchedulerRun" ADD CONSTRAINT "SchedulerRun_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A hand-run has an operator and only a hand-run has one.
ALTER TABLE "SchedulerRun" ADD CONSTRAINT "SchedulerRun_actor_matches_trigger" CHECK (
  ("trigger" = 'MANUAL') = ("actorId" IS NOT NULL)
);

-- The stale-run recovery reads only open runs; this keeps it off the history.
CREATE INDEX "SchedulerRun_running_idx" ON "SchedulerRun"("startedAt") WHERE "status" = 'RUNNING';

-- The guard, re-created. What it refused before it still refuses — DELETE,
-- touching a closed row, changing identity — and the one new thing it allows
-- is a heartbeat: an open run renewing its lease, moving `heartbeatAt` forward
-- and nothing else. Closing is unchanged: RUNNING → SUCCESS/FAILED, once.
CREATE OR REPLACE FUNCTION "scheduler_run_guard_fn"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SchedulerRun rows are append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'RUNNING'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."jobKey" IS DISTINCT FROM OLD."jobKey"
     OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."actorId" IS DISTINCT FROM OLD."actorId" THEN
    RAISE EXCEPTION 'A SchedulerRun is closed once, from RUNNING, and nothing else on it changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'RUNNING' AND (
       NEW."heartbeatAt" IS NULL
       OR (OLD."heartbeatAt" IS NOT NULL AND NEW."heartbeatAt" < OLD."heartbeatAt")
       OR NEW."finishedAt" IS DISTINCT FROM OLD."finishedAt"
       OR NEW."summary" IS DISTINCT FROM OLD."summary"
       OR NEW."errorCode" IS DISTINCT FROM OLD."errorCode"
     ) THEN
    RAISE EXCEPTION 'An open SchedulerRun may only move its heartbeat forward'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

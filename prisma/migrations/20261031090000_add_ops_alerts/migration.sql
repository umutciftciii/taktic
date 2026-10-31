-- OBS-ALERT-001: persistent operations alerts (scheduler failures and late
-- jobs, failing e-mail) delivered to Telegram and e-mail.
--
-- Additive: three new tables and their enums. No existing table, row,
-- index or trigger is touched, and nothing is backfilled — the first
-- evaluation after deploy reads the current state and opens alerts for what
-- is wrong now. Rollback is dropping the three tables and six enums
-- (scripts/ops/obs-alert-001-rollback.sql); nothing else depends on them.
--
-- Why persisted: an alert that lived in process memory would be re-sent on
-- every restart and its recovery notice lost, and two evaluators could not
-- agree on who sends. The rows hold no address, no message body, no token
-- and no raw error text — keys, closed codes, counters and timestamps only.

-- CreateEnum
CREATE TYPE "OpsAlertSource" AS ENUM ('SCHEDULER', 'EMAIL');

-- CreateEnum
CREATE TYPE "OpsAlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "OpsAlertState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OpsAlertNoticeKind" AS ENUM ('OPENED', 'REMINDER', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OpsAlertChannel" AS ENUM ('TELEGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "OpsAlertDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'ABANDONED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" "OpsAlertSource" NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "severity" "OpsAlertSeverity" NOT NULL,
    "state" "OpsAlertState" NOT NULL DEFAULT 'OPEN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastNotifiedAt" TIMESTAMP(3) NOT NULL,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertDelivery" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "kind" "OpsAlertNoticeKind" NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "channel" "OpsAlertChannel" NOT NULL,
    "status" "OpsAlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAlertEngineState" (
    "id" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "lastErrorType" TEXT,
    "emailCursor" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAlertEngineState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_ref_key" ON "OpsAlert"("ref");

-- CreateIndex
CREATE INDEX "OpsAlert_state_lastSeenAt_idx" ON "OpsAlert"("state", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OpsAlert_fingerprint_createdAt_idx" ON "OpsAlert"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAlertDelivery_status_nextAttemptAt_idx" ON "OpsAlertDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlertDelivery_alertId_kind_sequence_channel_key" ON "OpsAlertDelivery"("alertId", "kind", "sequence", "channel");

-- AddForeignKey
ALTER TABLE "OpsAlertDelivery" ADD CONSTRAINT "OpsAlertDelivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "OpsAlert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one OPEN alert per problem: a second evaluator racing the first
-- (another instance, a restart mid-tick) collides here and opens nothing.
CREATE UNIQUE INDEX "OpsAlert_fingerprint_open_key" ON "OpsAlert"("fingerprint") WHERE "state" = 'OPEN';

ALTER TABLE "OpsAlert"
  ADD CONSTRAINT "OpsAlert_resolution_check" CHECK (
    ("state" = 'OPEN' AND "resolvedAt" IS NULL AND "resolution" IS NULL)
    OR ("state" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolution" IN ('RECOVERED', 'DISABLED', 'SUPERSEDED'))
  ),
  ADD CONSTRAINT "OpsAlert_counts_check" CHECK ("occurrenceCount" >= 1 AND "reminderCount" >= 0),
  ADD CONSTRAINT "OpsAlert_seen_check" CHECK ("lastSeenAt" >= "firstSeenAt");

-- A claim is a token and a moment, held exactly while SENDING.
ALTER TABLE "OpsAlertDelivery"
  ADD CONSTRAINT "OpsAlertDelivery_claim_check" CHECK (
    ("status" = 'SENDING') = ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "OpsAlertDelivery_counts_check" CHECK ("attemptCount" >= 0 AND "sequence" >= 0),
  ADD CONSTRAINT "OpsAlertDelivery_sequence_check" CHECK (("kind" = 'REMINDER') = ("sequence" > 0));

-- One row, by name.
ALTER TABLE "OpsAlertEngineState"
  ADD CONSTRAINT "OpsAlertEngineState_singleton_check" CHECK ("id" = 'ops-alert-engine');

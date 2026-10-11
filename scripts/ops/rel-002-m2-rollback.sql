-- REL-002 M2 rollback — undo 20261011180000_enforce_round_matching_core.
--
-- For an emergency revert of the Faz 2 code to the Faz 1 release (d55d92f1),
-- and only while every request still has exactly one match round — that is,
-- before Faz 3 opens a second round anywhere. After that, the per-request
-- uniques cannot be restored and the only way back is forward.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-m2-rollback.sql
--
-- Run with the API stopped, after a fresh backup (backup-db.sh). One
-- transaction: it either leaves the database exactly at the M1 schema (95
-- migrations; the drift check against the Faz 1 schema.prisma reports no
-- difference) or changes nothing. Data is not touched — every round, round id
-- and link stays as it is; the Faz 1 code writes them all again itself.
--
-- Rehearsed on a restored copy and on the 200k-request synthetic database
-- (REL-002 doc §31): rollback → drift 0 against d55d92f1 → `migrate deploy`
-- re-applies M2 cleanly.

BEGIN;

-- Refuse a database that already relies on per-round uniques.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceRequestMatchRound" GROUP BY "requestId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'REL-002 M2 rollback refused: some request has more than one match round';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations"
                 WHERE migration_name = '20261011180000_enforce_round_matching_core'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'REL-002 M2 rollback refused: M2 is not applied here';
  END IF;
END;
$$;

-- Triggers and their functions.
DROP TRIGGER "ServiceRequest_round_one_at_birth" ON "ServiceRequest";
DROP FUNCTION "service_request_round_one_fn"();
DROP TRIGGER "Offer_round_link_default" ON "Offer";
DROP TRIGGER "ContactRevealEvent_round_link_default" ON "ContactRevealEvent";
DROP TRIGGER "MessageThread_round_link_default" ON "MessageThread";
DROP FUNCTION "round_link_default_fn"();

-- Scheduler indexes.
DROP INDEX "ServiceRequestMatchRound_status_expiresAt_idx";
DROP INDEX "ServiceRequestMatchRound_status_reminderSentAt_publishedAt_idx";

-- Round shape: back to M1's single CHECK.
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_open_has_no_outcome";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_matched_shape";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_completed_shape";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_cancelled_shape";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_expired_shape";
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_publication_pair";
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_matched_has_offer"
    CHECK ("status" NOT IN ('MATCHED', 'COMPLETED')
           OR ("matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL));

-- Composite FKs back to M1's single-column ones.
ALTER TABLE "ServiceRequestMatchRound" ALTER CONSTRAINT "ServiceRequestMatchRound_requestId_fkey" NOT DEFERRABLE;

ALTER TABLE "ServiceRequest" DROP CONSTRAINT "ServiceRequest_currentRoundId_id_fkey";
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_currentRoundId_fkey"
    FOREIGN KEY ("currentRoundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "ServiceRequestMatchRound_matchedOfferId_id_fkey";
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_matchedOfferId_fkey"
    FOREIGN KEY ("matchedOfferId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Offer" DROP CONSTRAINT "Offer_matchRoundId_requestId_fkey";
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_matchRoundId_fkey"
    FOREIGN KEY ("matchRoundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "Offer_id_matchRoundId_key";
DROP INDEX "ServiceRequestMatchRound_id_requestId_key";

-- Uniques: per round → per request (equivalent while every request has one round).
DROP INDEX "MessageThread_requestId_idx";
CREATE UNIQUE INDEX "MessageThread_requestId_key" ON "MessageThread"("requestId");

DROP INDEX "ContactRevealEvent_requestId_idx";
CREATE UNIQUE INDEX "ContactRevealEvent_requestId_key" ON "ContactRevealEvent"("requestId");

DROP INDEX "Offer_one_accepted_per_round";
CREATE UNIQUE INDEX "Offer_one_accepted_per_request" ON "Offer"("requestId") WHERE "status" = 'ACCEPTED';

DROP INDEX "Offer_providerId_matchRoundId_key";
CREATE UNIQUE INDEX "Offer_providerId_requestId_key" ON "Offer"("providerId", "requestId");

-- Nullable again (the Faz 1 schema); the values stay.
ALTER TABLE "ServiceRequest"     ALTER COLUMN "currentRoundId" DROP NOT NULL;
ALTER TABLE "Offer"              ALTER COLUMN "matchRoundId"   DROP NOT NULL;
ALTER TABLE "ContactRevealEvent" ALTER COLUMN "roundId"        DROP NOT NULL;
ALTER TABLE "MessageThread"      ALTER COLUMN "roundId"        DROP NOT NULL;

-- Prisma's record of M2, so a later `migrate deploy` re-applies it.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261011180000_enforce_round_matching_core';

COMMIT;

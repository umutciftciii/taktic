-- REL-002 Faz 1 (M1): service request match rounds — expand + backfill.
--
-- Additive only. Nothing existing is dropped, tightened or rewritten:
--
--   * one new table (ServiceRequestMatchRound) and three enums;
--   * four new NULLABLE columns: ServiceRequest.currentRoundId,
--     Offer.matchRoundId, ContactRevealEvent.roundId, MessageThread.roundId;
--   * every existing unique stays exactly as it is (Offer_providerId_requestId_key,
--     Offer_one_accepted_per_request, ContactRevealEvent_requestId_key,
--     MessageThread_requestId_key, ServiceRequest_matchedOfferId_key).
--     Swapping them for per-round ones is Faz 2 (M2).
--
-- Backfill: exactly one Round 1 per existing request, id 'mr1_' || requestId
-- (deterministic, so a re-run is a no-op), derived from the request's own
-- columns. No date is invented: a NULL stays NULL. Every offer, contact reveal
-- and message thread is attached to its request's Round 1 (today a request has
-- exactly one matching cycle, so that is the round all of them belong to).
--
-- The application derives the round with the same mapping
-- (apps/api/src/modules/match-rounds/match-round-projection.ts) on every
-- lifecycle write; scripts/ops/rel-002-round-consistency.sql checks the two
-- agree. The verification block at the end refuses the migration — and with it
-- the whole transaction — if any invariant does not hold.
--
-- Preflight: scripts/ops/rel-002-preflight.sql (read-only) must report 0 for
-- every integrity counter first.

-- CreateEnum
CREATE TYPE "MatchRoundStatus" AS ENUM ('OPEN', 'MATCHED', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MatchRoundSource" AS ENUM ('MARKETPLACE', 'DIRECT_SHOWCASE');

-- CreateEnum
CREATE TYPE "MatchRoundOpenedBy" AS ENUM ('REQUEST_CREATED');

-- AlterTable (nullable, no default: metadata-only, no table rewrite)
ALTER TABLE "ServiceRequest" ADD COLUMN     "currentRoundId" TEXT;

-- AlterTable
ALTER TABLE "ContactRevealEvent" ADD COLUMN     "roundId" TEXT;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "matchRoundId" TEXT;

-- AlterTable
ALTER TABLE "MessageThread" ADD COLUMN     "roundId" TEXT;

-- CreateTable
CREATE TABLE "ServiceRequestMatchRound" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "status" "MatchRoundStatus" NOT NULL DEFAULT 'OPEN',
    "source" "MatchRoundSource" NOT NULL,
    "openedBy" "MatchRoundOpenedBy" NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "matchedAt" TIMESTAMP(3),
    "matchedOfferId" TEXT,
    "matchedProviderId" TEXT,
    "failedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequestMatchRound_pkey" PRIMARY KEY ("id")
);

-- ── Backfill: Round 1 ────────────────────────────────────────────────────────
--
-- request.status            → round.status   publishedAt
-- DRAFT/SUBMITTED/IN_REVIEW → OPEN           NULL (still in moderation)
-- APPROVED                  → OPEN           approvedAt (NULL stays NULL)
-- REJECTED                  → OPEN           approvedAt (request.status keeps
--                                            the visibility; a report's removal
--                                            can be reopened into this round)
-- MATCHED                   → MATCHED        approvedAt
-- COMPLETED                 → COMPLETED      approvedAt
-- CANCELLED                 → CANCELLED      approvedAt
-- EXPIRED                   → EXPIRED        approvedAt
--
-- matchedOfferId/matchedAt are carried for MATCHED, COMPLETED and CANCELLED (a
-- cancelled match keeps its record, as the request does); matchedProviderId is
-- the matched offer's provider. completedAt/cancelledAt/expiredAt are carried
-- for their own status only. expiresAt = publishedAt + 14 days
-- (REQUEST_EXPIRY_DAYS), the scheduler's own rule, NULL with publishedAt.
-- source is DIRECT_SHOWCASE only while a vitrin lead still holds the gate
-- (showcaseLeadId and directShowcaseProviderId both set); a released lead is a
-- marketplace request.
INSERT INTO "ServiceRequestMatchRound" (
    "id", "requestId", "roundNumber", "status", "source", "openedBy", "openedAt",
    "publishedAt", "expiresAt", "reminderSentAt",
    "matchedAt", "matchedOfferId", "matchedProviderId",
    "completedAt", "cancelledAt", "expiredAt",
    "createdAt", "updatedAt"
)
SELECT
    'mr1_' || r."id",
    r."id",
    1,
    (CASE r."status"
        WHEN 'MATCHED'   THEN 'MATCHED'
        WHEN 'COMPLETED' THEN 'COMPLETED'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        WHEN 'EXPIRED'   THEN 'EXPIRED'
        ELSE 'OPEN'
    END)::"MatchRoundStatus",
    (CASE
        WHEN r."showcaseLeadId" IS NOT NULL AND r."directShowcaseProviderId" IS NOT NULL
            THEN 'DIRECT_SHOWCASE'
        ELSE 'MARKETPLACE'
    END)::"MatchRoundSource",
    'REQUEST_CREATED'::"MatchRoundOpenedBy",
    r."submittedAt",
    p."publishedAt",
    p."publishedAt" + INTERVAL '14 days',
    r."reminderSentAt",
    CASE WHEN m."carries" THEN r."matchedAt" END,
    CASE WHEN m."carries" THEN r."matchedOfferId" END,
    CASE WHEN m."carries" THEN o."providerId" END,
    CASE WHEN r."status" = 'COMPLETED' THEN r."completedAt" END,
    CASE WHEN r."status" = 'CANCELLED' THEN r."cancelledAt" END,
    CASE WHEN r."status" = 'EXPIRED'   THEN r."expiredAt"   END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "ServiceRequest" r
CROSS JOIN LATERAL (
    SELECT CASE
        WHEN r."status" IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW') THEN NULL
        ELSE r."approvedAt"
    END AS "publishedAt"
) p
CROSS JOIN LATERAL (
    SELECT (r."status" IN ('MATCHED', 'COMPLETED', 'CANCELLED') AND r."matchedOfferId" IS NOT NULL) AS "carries"
) m
LEFT JOIN "Offer" o ON o."id" = r."matchedOfferId"
ON CONFLICT ("id") DO NOTHING;

-- ── Backfill: attach everything to its request's Round 1 ─────────────────────
UPDATE "ServiceRequest"     SET "currentRoundId" = 'mr1_' || "id"        WHERE "currentRoundId" IS NULL;
UPDATE "Offer"              SET "matchRoundId"   = 'mr1_' || "requestId" WHERE "matchRoundId"   IS NULL;
UPDATE "ContactRevealEvent" SET "roundId"        = 'mr1_' || "requestId" WHERE "roundId"        IS NULL;
UPDATE "MessageThread"      SET "roundId"        = 'mr1_' || "requestId" WHERE "roundId"        IS NULL;

-- ── Indexes (after the backfill, so it does not maintain them row by row) ────

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestMatchRound_matchedOfferId_key" ON "ServiceRequestMatchRound"("matchedOfferId");

-- CreateIndex
CREATE INDEX "ServiceRequestMatchRound_matchedProviderId_idx" ON "ServiceRequestMatchRound"("matchedProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestMatchRound_requestId_roundNumber_key" ON "ServiceRequestMatchRound"("requestId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequest_currentRoundId_key" ON "ServiceRequest"("currentRoundId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactRevealEvent_roundId_key" ON "ContactRevealEvent"("roundId");

-- CreateIndex
CREATE INDEX "Offer_matchRoundId_status_idx" ON "Offer"("matchRoundId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_roundId_key" ON "MessageThread"("roundId");

-- At most one active (OPEN or MATCHED) round per request. Prisma cannot express
-- a partial index, so it lives here. With one round per request it holds by
-- construction today; from Faz 3 on it is what keeps two rounds of one request
-- from being open at once.
CREATE UNIQUE INDEX "MatchRound_one_active_per_request"
    ON "ServiceRequestMatchRound"("requestId")
    WHERE "status" IN ('OPEN', 'MATCHED');

-- ── Foreign keys ─────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_currentRoundId_fkey" FOREIGN KEY ("currentRoundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_matchedOfferId_fkey" FOREIGN KEY ("matchedOfferId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_matchedProviderId_fkey" FOREIGN KEY ("matchedProviderId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_matchRoundId_fkey" FOREIGN KEY ("matchRoundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "ServiceRequestMatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Round invariants Prisma cannot express ───────────────────────────────────

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_number_positive"
    CHECK ("roundNumber" >= 1);

-- A matched or completed round names its winner and the winner's provider.
-- (A CANCELLED round may or may not have had a match; an OPEN one never
-- carries one, which the application's projection guarantees and the
-- consistency check verifies — not enforced here, so a legacy shape cannot
-- turn an ordinary lifecycle write into an error in Faz 1.)
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_matched_has_offer"
    CHECK ("status" NOT IN ('MATCHED', 'COMPLETED')
           OR ("matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL));

-- A finished round stays finished. Request statuses COMPLETED, CANCELLED and
-- EXPIRED are already terminal in the application (nothing moves a request out
-- of them), so the round they project to never needs to move either; this is
-- the backstop against a hand-written UPDATE. Other columns stay writable.
CREATE FUNCTION "match_round_terminal_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'ServiceRequestMatchRound % is % and its status cannot change (to %)',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MatchRound_terminal_status_immutable"
  BEFORE UPDATE OF "status" ON "ServiceRequestMatchRound"
  FOR EACH ROW EXECUTE FUNCTION "match_round_terminal_guard_fn"();

-- ── Verification: refuse the migration if the backfill is not exact ─────────
DO $$
DECLARE
  requests_total          bigint;
  rounds_total            bigint;
  requests_without_round  bigint;
  requests_bad_current    bigint;
  offers_bad_round        bigint;
  reveals_bad_round       bigint;
  threads_bad_round       bigint;
  matched_mismatch        bigint;
  provider_mismatch       bigint;
  winner_not_accepted     bigint;
BEGIN
  SELECT count(*) INTO requests_total FROM "ServiceRequest";
  SELECT count(*) INTO rounds_total   FROM "ServiceRequestMatchRound";

  -- Every request has exactly one round, and it is its Round 1.
  SELECT count(*) INTO requests_without_round
  FROM "ServiceRequest" r
  WHERE (SELECT count(*) FROM "ServiceRequestMatchRound" mr WHERE mr."requestId" = r."id") <> 1;

  SELECT count(*) INTO requests_bad_current
  FROM "ServiceRequest" r
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = r."currentRoundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> r."id" OR mr."roundNumber" <> 1;

  -- Every offer, reveal and thread sits in a round of its own request; a
  -- reveal or thread sits in its offer's round.
  SELECT count(*) INTO offers_bad_round
  FROM "Offer" o
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = o."matchRoundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> o."requestId";

  SELECT count(*) INTO reveals_bad_round
  FROM "ContactRevealEvent" e
  JOIN "Offer" o ON o."id" = e."offerId"
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = e."roundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> e."requestId" OR e."roundId" IS DISTINCT FROM o."matchRoundId";

  SELECT count(*) INTO threads_bad_round
  FROM "MessageThread" t
  JOIN "Offer" o ON o."id" = t."offerId"
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = t."roundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> t."requestId" OR t."roundId" IS DISTINCT FROM o."matchRoundId";

  -- A matched or completed round agrees with the request projection, names the
  -- winner's own provider, and the winner is an ACCEPTED offer.
  SELECT count(*) INTO matched_mismatch
  FROM "ServiceRequest" r
  JOIN "ServiceRequestMatchRound" mr ON mr."id" = r."currentRoundId"
  WHERE r."status" IN ('MATCHED', 'COMPLETED')
    AND (mr."status"::text <> r."status"::text
         OR mr."matchedOfferId" IS DISTINCT FROM r."matchedOfferId"
         OR mr."matchedAt" IS DISTINCT FROM r."matchedAt");

  SELECT count(*) INTO provider_mismatch
  FROM "ServiceRequestMatchRound" mr
  JOIN "Offer" o ON o."id" = mr."matchedOfferId"
  WHERE mr."matchedProviderId" IS DISTINCT FROM o."providerId";

  SELECT count(*) INTO winner_not_accepted
  FROM "ServiceRequestMatchRound" mr
  JOIN "Offer" o ON o."id" = mr."matchedOfferId"
  WHERE mr."status" IN ('MATCHED', 'COMPLETED') AND o."status" <> 'ACCEPTED';

  IF rounds_total <> requests_total
     OR requests_without_round <> 0
     OR requests_bad_current <> 0
     OR offers_bad_round <> 0
     OR reveals_bad_round <> 0
     OR threads_bad_round <> 0
     OR matched_mismatch <> 0
     OR provider_mismatch <> 0
     OR winner_not_accepted <> 0 THEN
    RAISE EXCEPTION 'REL-002 M1 backfill verification failed: requests=% rounds=% requests_without_round=% requests_bad_current=% offers_bad_round=% reveals_bad_round=% threads_bad_round=% matched_mismatch=% provider_mismatch=% winner_not_accepted=%',
      requests_total, rounds_total, requests_without_round, requests_bad_current,
      offers_bad_round, reveals_bad_round, threads_bad_round,
      matched_mismatch, provider_mismatch, winner_not_accepted;
  END IF;
END;
$$;

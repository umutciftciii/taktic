-- REL-002 Faz 2 (M2): enforce the round as the matching core's authority.
--
-- After this migration a match round is no longer a shadow of its request:
--
--   * every request, offer, contact reveal and message thread names its round
--     (NOT NULL);
--   * the per-request uniques are swapped for per-round ones — one offer per
--     provider per round, one ACCEPTED offer per round, one reveal and one
--     thread per round — so a later round can carry a match of its own while
--     an earlier one keeps its history;
--   * composite FKs pin a request's current round, an offer's round and a
--     round's winner to rows of the same request / the same round;
--   * a round's shape is checked per status (OPEN carries no match, MATCHED and
--     COMPLETED carry the winner, terminal states carry their own timestamp);
--   * a new request is born with its Round 1 in the database itself.
--
-- Safety. With exactly one round per request (asserted below, before any
-- swap), every new unique is *equivalent* to the one it replaces: no row that
-- satisfied the old one can violate the new one. The step-0 backfill is M1's
-- own, idempotent SQL, re-run for rows an older release may have written
-- between M1 and this code going live. The verification block refuses the
-- whole migration — it is one transaction — if any invariant does not hold.
--
-- Preflight: scripts/ops/rel-002-preflight.sql (read-only) must report 0 for
-- every integrity counter, including its M2 section.

-- ── 0. Re-backfill (M1's mapping; a no-op when M1's backfill is complete) ────
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
WHERE r."currentRoundId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "ServiceRequest"     SET "currentRoundId" = 'mr1_' || "id"        WHERE "currentRoundId" IS NULL;
UPDATE "Offer"              SET "matchRoundId"   = 'mr1_' || "requestId" WHERE "matchRoundId"   IS NULL;
UPDATE "ContactRevealEvent" SET "roundId"        = 'mr1_' || "requestId" WHERE "roundId"        IS NULL;
UPDATE "MessageThread"      SET "roundId"        = 'mr1_' || "requestId" WHERE "roundId"        IS NULL;

-- ── 1. Verify before tightening anything ─────────────────────────────────────
-- Everything the swaps and checks below rely on. A failure names the counter
-- and rolls the whole migration back.
DO $$
DECLARE
  requests_not_one_round   bigint;
  requests_bad_current     bigint;
  offers_bad_round         bigint;
  reveals_bad_round        bigint;
  threads_bad_round        bigint;
  dup_provider_round       bigint;
  dup_accepted_round       bigint;
  winner_wrong_round       bigint;
  bad_round_shape          bigint;
BEGIN
  SELECT count(*) INTO requests_not_one_round
  FROM "ServiceRequest" r
  WHERE (SELECT count(*) FROM "ServiceRequestMatchRound" mr WHERE mr."requestId" = r."id") <> 1;

  SELECT count(*) INTO requests_bad_current
  FROM "ServiceRequest" r
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = r."currentRoundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> r."id";

  SELECT count(*) INTO offers_bad_round
  FROM "Offer" o
  LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = o."matchRoundId"
  WHERE mr."id" IS NULL OR mr."requestId" <> o."requestId";

  SELECT count(*) INTO reveals_bad_round
  FROM "ContactRevealEvent" e
  JOIN "Offer" o ON o."id" = e."offerId"
  WHERE e."roundId" IS DISTINCT FROM o."matchRoundId" OR o."requestId" <> e."requestId";

  SELECT count(*) INTO threads_bad_round
  FROM "MessageThread" t
  JOIN "Offer" o ON o."id" = t."offerId"
  WHERE t."roundId" IS DISTINCT FROM o."matchRoundId" OR o."requestId" <> t."requestId";

  SELECT count(*) INTO dup_provider_round FROM (
    SELECT 1 FROM "Offer" GROUP BY "providerId", "matchRoundId" HAVING count(*) > 1
  ) d;

  SELECT count(*) INTO dup_accepted_round FROM (
    SELECT 1 FROM "Offer" WHERE "status" = 'ACCEPTED' GROUP BY "matchRoundId" HAVING count(*) > 1
  ) d;

  SELECT count(*) INTO winner_wrong_round
  FROM "ServiceRequestMatchRound" mr
  JOIN "Offer" o ON o."id" = mr."matchedOfferId"
  WHERE o."matchRoundId" <> mr."id";

  -- The per-status shape the CHECK constraints below will enforce.
  SELECT count(*) INTO bad_round_shape
  FROM "ServiceRequestMatchRound" mr
  WHERE NOT (
    CASE mr."status"
      WHEN 'OPEN' THEN mr."matchedOfferId" IS NULL AND mr."matchedProviderId" IS NULL AND mr."matchedAt" IS NULL
                   AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL
                   AND mr."failedAt" IS NULL
      WHEN 'MATCHED' THEN mr."matchedOfferId" IS NOT NULL AND mr."matchedProviderId" IS NOT NULL AND mr."matchedAt" IS NOT NULL
                   AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL
                   AND mr."failedAt" IS NULL
      WHEN 'COMPLETED' THEN mr."matchedOfferId" IS NOT NULL AND mr."matchedProviderId" IS NOT NULL AND mr."matchedAt" IS NOT NULL
                   AND mr."completedAt" IS NOT NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL
                   AND mr."failedAt" IS NULL
      WHEN 'CANCELLED' THEN mr."cancelledAt" IS NOT NULL AND mr."completedAt" IS NULL AND mr."expiredAt" IS NULL
                   AND mr."failedAt" IS NULL
                   AND (mr."matchedOfferId" IS NULL) = (mr."matchedProviderId" IS NULL)
                   AND (mr."matchedOfferId" IS NOT NULL OR mr."matchedAt" IS NULL)
      WHEN 'EXPIRED' THEN mr."expiredAt" IS NOT NULL AND mr."matchedOfferId" IS NULL AND mr."matchedProviderId" IS NULL
                   AND mr."matchedAt" IS NULL AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL
                   AND mr."failedAt" IS NULL
      ELSE false
    END
  ) OR (mr."publishedAt" IS NULL) <> (mr."expiresAt" IS NULL);

  IF requests_not_one_round <> 0
     OR requests_bad_current <> 0
     OR offers_bad_round <> 0
     OR reveals_bad_round <> 0
     OR threads_bad_round <> 0
     OR dup_provider_round <> 0
     OR dup_accepted_round <> 0
     OR winner_wrong_round <> 0
     OR bad_round_shape <> 0 THEN
    RAISE EXCEPTION 'REL-002 M2 verification failed: requests_not_one_round=% requests_bad_current=% offers_bad_round=% reveals_bad_round=% threads_bad_round=% dup_provider_round=% dup_accepted_round=% winner_wrong_round=% bad_round_shape=%',
      requests_not_one_round, requests_bad_current, offers_bad_round, reveals_bad_round,
      threads_bad_round, dup_provider_round, dup_accepted_round, winner_wrong_round, bad_round_shape;
  END IF;
END;
$$;

-- ── 2. NOT NULL (CHECK NOT VALID → VALIDATE → SET NOT NULL → drop the CHECK) ─
-- SET NOT NULL on PostgreSQL ≥ 12 skips its own full-table scan when a
-- validated CHECK already proves the column non-null; VALIDATE takes only a
-- SHARE UPDATE EXCLUSIVE lock. The helper CHECKs are dropped once they have
-- done that job — the column constraint is the invariant.
ALTER TABLE "ServiceRequest"     ADD CONSTRAINT "ServiceRequest_currentRoundId_not_null" CHECK ("currentRoundId" IS NOT NULL) NOT VALID;
ALTER TABLE "Offer"              ADD CONSTRAINT "Offer_matchRoundId_not_null"            CHECK ("matchRoundId"   IS NOT NULL) NOT VALID;
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_roundId_not_null"    CHECK ("roundId"        IS NOT NULL) NOT VALID;
ALTER TABLE "MessageThread"      ADD CONSTRAINT "MessageThread_roundId_not_null"         CHECK ("roundId"        IS NOT NULL) NOT VALID;

ALTER TABLE "ServiceRequest"     VALIDATE CONSTRAINT "ServiceRequest_currentRoundId_not_null";
ALTER TABLE "Offer"              VALIDATE CONSTRAINT "Offer_matchRoundId_not_null";
ALTER TABLE "ContactRevealEvent" VALIDATE CONSTRAINT "ContactRevealEvent_roundId_not_null";
ALTER TABLE "MessageThread"      VALIDATE CONSTRAINT "MessageThread_roundId_not_null";

ALTER TABLE "ServiceRequest"     ALTER COLUMN "currentRoundId" SET NOT NULL;
ALTER TABLE "Offer"              ALTER COLUMN "matchRoundId"   SET NOT NULL;
ALTER TABLE "ContactRevealEvent" ALTER COLUMN "roundId"        SET NOT NULL;
ALTER TABLE "MessageThread"      ALTER COLUMN "roundId"        SET NOT NULL;

ALTER TABLE "ServiceRequest"     DROP CONSTRAINT "ServiceRequest_currentRoundId_not_null";
ALTER TABLE "Offer"              DROP CONSTRAINT "Offer_matchRoundId_not_null";
ALTER TABLE "ContactRevealEvent" DROP CONSTRAINT "ContactRevealEvent_roundId_not_null";
ALTER TABLE "MessageThread"      DROP CONSTRAINT "MessageThread_roundId_not_null";

-- ── 3. Unique swaps: per request → per round ─────────────────────────────────
DROP INDEX "Offer_providerId_requestId_key";
CREATE UNIQUE INDEX "Offer_providerId_matchRoundId_key" ON "Offer"("providerId", "matchRoundId");

-- One ACCEPTED offer per round (partial; Prisma cannot express it). A failed
-- round's winner stays ACCEPTED (REL-002 §3.3), so the next round needs room
-- for its own.
DROP INDEX "Offer_one_accepted_per_request";
CREATE UNIQUE INDEX "Offer_one_accepted_per_round" ON "Offer"("matchRoundId") WHERE "status" = 'ACCEPTED';

-- Reveal and thread: `roundId @unique` (M1) becomes the only "one per match"
-- unique; requestId is an ordinary index for the request-scoped readers.
DROP INDEX "ContactRevealEvent_requestId_key";
CREATE INDEX "ContactRevealEvent_requestId_idx" ON "ContactRevealEvent"("requestId");

DROP INDEX "MessageThread_requestId_key";
CREATE INDEX "MessageThread_requestId_idx" ON "MessageThread"("requestId");

-- ── 4. Composite invariants ──────────────────────────────────────────────────
-- Targets of the composite FKs.
CREATE UNIQUE INDEX "Offer_id_matchRoundId_key" ON "Offer"("id", "matchRoundId");
CREATE UNIQUE INDEX "ServiceRequestMatchRound_id_requestId_key" ON "ServiceRequestMatchRound"("id", "requestId");

-- An offer's round is a round of the offer's own request.
ALTER TABLE "Offer" DROP CONSTRAINT "Offer_matchRoundId_fkey";
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_matchRoundId_requestId_fkey"
    FOREIGN KEY ("matchRoundId", "requestId") REFERENCES "ServiceRequestMatchRound"("id", "requestId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A round's winner is an offer made in that round.
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "ServiceRequestMatchRound_matchedOfferId_fkey";
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "ServiceRequestMatchRound_matchedOfferId_id_fkey"
    FOREIGN KEY ("matchedOfferId", "id") REFERENCES "Offer"("id", "matchRoundId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A request's current round is one of the request's own rounds.
ALTER TABLE "ServiceRequest" DROP CONSTRAINT "ServiceRequest_currentRoundId_fkey";
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_currentRoundId_id_fkey"
    FOREIGN KEY ("currentRoundId", "id") REFERENCES "ServiceRequestMatchRound"("id", "requestId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The request ↔ round FKs are now circular and both NOT NULL. The round's
-- own FK to its request is checked at commit, which is what lets a request
-- and its Round 1 be inserted in one transaction (see the birth trigger).
ALTER TABLE "ServiceRequestMatchRound" ALTER CONSTRAINT "ServiceRequestMatchRound_requestId_fkey"
    DEFERRABLE INITIALLY DEFERRED;

-- ── 5. Round shape per status ────────────────────────────────────────────────
-- Replaces M1's MatchRound_matched_has_offer with the full per-status shape.
-- Verified above on the existing rows, so VALIDATE cannot fail here.
ALTER TABLE "ServiceRequestMatchRound" DROP CONSTRAINT "MatchRound_matched_has_offer";

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_open_has_no_outcome"
    CHECK ("status" <> 'OPEN' OR (
        "matchedOfferId" IS NULL AND "matchedProviderId" IS NULL AND "matchedAt" IS NULL
        AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "expiredAt" IS NULL AND "failedAt" IS NULL
    )) NOT VALID;

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_matched_shape"
    CHECK ("status" <> 'MATCHED' OR (
        "matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL AND "matchedAt" IS NOT NULL
        AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "expiredAt" IS NULL AND "failedAt" IS NULL
    )) NOT VALID;

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_completed_shape"
    CHECK ("status" <> 'COMPLETED' OR (
        "matchedOfferId" IS NOT NULL AND "matchedProviderId" IS NOT NULL AND "matchedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "expiredAt" IS NULL AND "failedAt" IS NULL
    )) NOT VALID;

-- A cancelled round may or may not have had a match (a cancel before or after
-- acceptance); when it did, the match record is whole and stays as history.
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_cancelled_shape"
    CHECK ("status" <> 'CANCELLED' OR (
        "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND "expiredAt" IS NULL AND "failedAt" IS NULL
        AND ("matchedOfferId" IS NULL) = ("matchedProviderId" IS NULL)
        AND ("matchedOfferId" IS NOT NULL OR "matchedAt" IS NULL)
    )) NOT VALID;

ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_expired_shape"
    CHECK ("status" <> 'EXPIRED' OR (
        "expiredAt" IS NOT NULL AND "matchedOfferId" IS NULL AND "matchedProviderId" IS NULL AND "matchedAt" IS NULL
        AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL
    )) NOT VALID;

-- The offer period's clock comes as a pair.
ALTER TABLE "ServiceRequestMatchRound" ADD CONSTRAINT "MatchRound_publication_pair"
    CHECK (("publishedAt" IS NULL) = ("expiresAt" IS NULL)) NOT VALID;

ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_open_has_no_outcome";
ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_matched_shape";
ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_completed_shape";
ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_cancelled_shape";
ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_expired_shape";
ALTER TABLE "ServiceRequestMatchRound" VALIDATE CONSTRAINT "MatchRound_publication_pair";

-- ── 6. Scheduler indexes (round clock) ───────────────────────────────────────
-- Expiry: "OPEN and expiresAt <= now". Reminder: "OPEN, not yet reminded,
-- published before the cutoff" — reminderSentAt leads publishedAt because it
-- is the equality predicate.
CREATE INDEX "ServiceRequestMatchRound_status_expiresAt_idx"
    ON "ServiceRequestMatchRound"("status", "expiresAt");
CREATE INDEX "ServiceRequestMatchRound_status_reminderSentAt_publishedAt_idx"
    ON "ServiceRequestMatchRound"("status", "reminderSentAt", "publishedAt");

-- ── 7. Birth: a request is inserted with its Round 1 ─────────────────────────
-- Every INSERT that leaves currentRoundId empty — the application's own create
-- path, a seed, a fixture — gets Round 1 (id 'mr1_' || id) in the same
-- statement. The round is born OPEN: a request enters the world in its first
-- offer period, and every later state is reached through an explicit round
-- transition. publishedAt follows M1's mapping (approvedAt once the request is
-- past moderation; NULL in moderation and for a legacy NULL approvedAt).
-- source starts as MARKETPLACE: a vitrin lead is attached after the insert, in
-- the same transaction, and the application marks the round DIRECT_SHOWCASE
-- then.
CREATE FUNCTION "service_request_round_one_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  published timestamp(3);
BEGIN
  IF NEW."currentRoundId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  published := CASE
    WHEN NEW."status" IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW') THEN NULL
    ELSE NEW."approvedAt"
  END;

  INSERT INTO "ServiceRequestMatchRound" (
      "id", "requestId", "roundNumber", "status", "source", "openedBy", "openedAt",
      "publishedAt", "expiresAt", "reminderSentAt", "createdAt", "updatedAt"
  ) VALUES (
      'mr1_' || NEW."id", NEW."id", 1, 'OPEN', 'MARKETPLACE', 'REQUEST_CREATED',
      coalesce(NEW."submittedAt", CURRENT_TIMESTAMP),
      published, published + INTERVAL '14 days', NEW."reminderSentAt",
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  NEW."currentRoundId" := 'mr1_' || NEW."id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServiceRequest_round_one_at_birth"
  BEFORE INSERT ON "ServiceRequest"
  FOR EACH ROW EXECUTE FUNCTION "service_request_round_one_fn"();

-- An offer, reveal or thread inserted without its round attaches to its
-- request's current round. The application always writes the round itself
-- (createOffer checks it is OPEN inside its transaction); this only keeps a
-- raw INSERT — a seed, a fixture, an older release during a rolling deploy —
-- from failing on NOT NULL. The composite FK still refuses a round of another
-- request.
CREATE FUNCTION "round_link_default_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Offer' THEN
    IF NEW."matchRoundId" IS NULL THEN
      SELECT r."currentRoundId" INTO NEW."matchRoundId" FROM "ServiceRequest" r WHERE r."id" = NEW."requestId";
    END IF;
  ELSE
    IF NEW."roundId" IS NULL THEN
      SELECT r."currentRoundId" INTO NEW."roundId" FROM "ServiceRequest" r WHERE r."id" = NEW."requestId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Offer_round_link_default"
  BEFORE INSERT ON "Offer"
  FOR EACH ROW EXECUTE FUNCTION "round_link_default_fn"();

CREATE TRIGGER "ContactRevealEvent_round_link_default"
  BEFORE INSERT ON "ContactRevealEvent"
  FOR EACH ROW EXECUTE FUNCTION "round_link_default_fn"();

CREATE TRIGGER "MessageThread_round_link_default"
  BEFORE INSERT ON "MessageThread"
  FOR EACH ROW EXECUTE FUNCTION "round_link_default_fn"();

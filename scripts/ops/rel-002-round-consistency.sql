-- REL-002: request ↔ match-round consistency — read-only, one statement.
--
-- Returns one row per violation and nothing when the data is consistent:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-round-consistency.sql
--
-- The API integration tests run this exact file after every lifecycle writer
-- (apps/api/test/match-round-consistency.ts), so it must stay a single SELECT
-- with no psql meta-commands. Not for a request path: it reads every request.
--
-- Since Faz 2 (M2) the round is the authority and the request's status /
-- matchedOfferId / matchedAt are its projection, written by the same
-- transactions (apps/api/src/modules/match-rounds/match-round-transitions.ts).
-- The expected current round is still the M1 mapping of the request: with
-- one round per request every writer keeps the two in exactly that relation.
-- The time fields (openedAt, publishedAt/expiresAt, reminderSentAt) and the
-- round number are compared for Round 1 only — a later round (Faz 3) runs its
-- own clock and is not a function of the request's legacy columns.
WITH expected AS (
  SELECT
    r."id"                                               AS "requestId",
    r."currentRoundId",
    (CASE r."status"
        WHEN 'MATCHED'   THEN 'MATCHED'
        WHEN 'COMPLETED' THEN 'COMPLETED'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        WHEN 'EXPIRED'   THEN 'EXPIRED'
        ELSE 'OPEN'
     END)                                                AS "status",
    (CASE
        WHEN r."showcaseLeadId" IS NOT NULL AND r."directShowcaseProviderId" IS NOT NULL
          THEN 'DIRECT_SHOWCASE'
        ELSE 'MARKETPLACE'
     END)                                                AS "source",
    r."submittedAt"                                      AS "openedAt",
    p."publishedAt",
    p."publishedAt" + INTERVAL '14 days'                 AS "expiresAt",
    r."reminderSentAt",
    CASE WHEN m."carries" THEN r."matchedAt" END         AS "matchedAt",
    CASE WHEN m."carries" THEN r."matchedOfferId" END    AS "matchedOfferId",
    CASE WHEN m."carries" THEN o."providerId" END        AS "matchedProviderId",
    CASE WHEN r."status" = 'COMPLETED' THEN r."completedAt" END AS "completedAt",
    CASE WHEN r."status" = 'CANCELLED' THEN r."cancelledAt" END AS "cancelledAt",
    CASE WHEN r."status" = 'EXPIRED'   THEN r."expiredAt"   END AS "expiredAt"
  FROM "ServiceRequest" r
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r."status" IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW') THEN NULL ELSE r."approvedAt" END AS "publishedAt"
  ) p
  CROSS JOIN LATERAL (
    SELECT (r."status" IN ('MATCHED', 'COMPLETED', 'CANCELLED') AND r."matchedOfferId" IS NOT NULL) AS "carries"
  ) m
  LEFT JOIN "Offer" o ON o."id" = r."matchedOfferId"
)
-- 1. Every request points at a round of its own.
SELECT e."requestId", 'request_current_round' AS "check",
       coalesce(e."currentRoundId", '<null>') AS "detail"
FROM expected e
LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = e."currentRoundId"
WHERE mr."id" IS NULL OR mr."requestId" <> e."requestId"

UNION ALL
-- 2. The current round is the request's latest round (round numbers are
--    1..N without gaps).
SELECT r."id", 'request_round_sequence',
       'current=' || cr."roundNumber" || ' max=' || agg."maxNumber" || ' count=' || agg."total"
FROM "ServiceRequest" r
JOIN "ServiceRequestMatchRound" cr ON cr."id" = r."currentRoundId"
CROSS JOIN LATERAL (
  SELECT max(mr."roundNumber") AS "maxNumber", count(*) AS "total"
  FROM "ServiceRequestMatchRound" mr WHERE mr."requestId" = r."id"
) agg
WHERE cr."roundNumber" <> agg."maxNumber" OR agg."maxNumber" <> agg."total"

UNION ALL
-- 3. The current round is exactly what the request projects to.
SELECT e."requestId", 'round_projection',
       concat_ws(' ',
         CASE WHEN mr."status"::text <> e."status" THEN 'status=' || mr."status" || '≠' || e."status" END,
         CASE WHEN mr."source"::text <> e."source" THEN 'source=' || mr."source" || '≠' || e."source" END,
         CASE WHEN mr."roundNumber" = 1 AND mr."openedAt" IS DISTINCT FROM e."openedAt" THEN 'openedAt' END,
         CASE WHEN mr."roundNumber" = 1 AND mr."publishedAt" IS DISTINCT FROM e."publishedAt" THEN 'publishedAt' END,
         CASE WHEN mr."roundNumber" = 1 AND mr."expiresAt" IS DISTINCT FROM e."expiresAt" THEN 'expiresAt' END,
         CASE WHEN mr."roundNumber" = 1 AND mr."reminderSentAt" IS DISTINCT FROM e."reminderSentAt" THEN 'reminderSentAt' END,
         CASE WHEN mr."matchedAt" IS DISTINCT FROM e."matchedAt" THEN 'matchedAt' END,
         CASE WHEN mr."matchedOfferId" IS DISTINCT FROM e."matchedOfferId" THEN 'matchedOfferId' END,
         CASE WHEN mr."matchedProviderId" IS DISTINCT FROM e."matchedProviderId" THEN 'matchedProviderId' END,
         CASE WHEN mr."completedAt" IS DISTINCT FROM e."completedAt" THEN 'completedAt' END,
         CASE WHEN mr."cancelledAt" IS DISTINCT FROM e."cancelledAt" THEN 'cancelledAt' END,
         CASE WHEN mr."expiredAt" IS DISTINCT FROM e."expiredAt" THEN 'expiredAt' END,
         CASE WHEN mr."failedAt" IS NOT NULL THEN 'failedAt (no FAILED round before Faz 3)' END)
FROM expected e
JOIN "ServiceRequestMatchRound" mr ON mr."id" = e."currentRoundId"
WHERE mr."status"::text <> e."status"
   OR mr."source"::text <> e."source"
   OR (mr."roundNumber" = 1 AND (
         mr."openedAt" IS DISTINCT FROM e."openedAt"
      OR mr."publishedAt" IS DISTINCT FROM e."publishedAt"
      OR mr."expiresAt" IS DISTINCT FROM e."expiresAt"
      OR mr."reminderSentAt" IS DISTINCT FROM e."reminderSentAt"))
   OR mr."matchedAt" IS DISTINCT FROM e."matchedAt"
   OR mr."matchedOfferId" IS DISTINCT FROM e."matchedOfferId"
   OR mr."matchedProviderId" IS DISTINCT FROM e."matchedProviderId"
   OR mr."completedAt" IS DISTINCT FROM e."completedAt"
   OR mr."cancelledAt" IS DISTINCT FROM e."cancelledAt"
   OR mr."expiredAt" IS DISTINCT FROM e."expiredAt"
   OR mr."failedAt" IS NOT NULL

UNION ALL
-- 3b. A round's winner was made in that round (also a composite FK since M2).
SELECT mr."requestId", 'winner_round', mr."id" || ' → ' || o."id" || ' in ' || o."matchRoundId"
FROM "ServiceRequestMatchRound" mr
JOIN "Offer" o ON o."id" = mr."matchedOfferId"
WHERE o."matchRoundId" <> mr."id"

UNION ALL
-- 4. Every offer sits in a round of its own request.
SELECT o."requestId", 'offer_round', o."id" || ' → ' || coalesce(o."matchRoundId", '<null>')
FROM "Offer" o
LEFT JOIN "ServiceRequestMatchRound" mr ON mr."id" = o."matchRoundId"
WHERE mr."id" IS NULL OR mr."requestId" <> o."requestId"

UNION ALL
-- 5. A contact reveal sits in its offer's round.
SELECT e."requestId", 'reveal_round', e."id" || ' → ' || coalesce(e."roundId", '<null>')
FROM "ContactRevealEvent" e
JOIN "Offer" o ON o."id" = e."offerId"
WHERE e."roundId" IS NULL OR e."roundId" IS DISTINCT FROM o."matchRoundId"

UNION ALL
-- 6. A message thread sits in its offer's round.
SELECT t."requestId", 'thread_round', t."id" || ' → ' || coalesce(t."roundId", '<null>')
FROM "MessageThread" t
JOIN "Offer" o ON o."id" = t."offerId"
WHERE t."roundId" IS NULL OR t."roundId" IS DISTINCT FROM o."matchRoundId"

ORDER BY 1, 2;

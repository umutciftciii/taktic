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
--
-- Faz 3: a request in MATCH_REVIEW projects to a FAILED current round, and a
-- FAILED round keeps its winner while the request's projection is NULL, so the
-- match columns are not compared for it; checks 7–10 cover the failure record
-- itself (incident, exclusion, terminal history, no excluded provider back).
WITH expected AS (
  SELECT
    r."id"                                               AS "requestId",
    r."currentRoundId",
    -- ::text so the script also runs on a database before M3, whose enum has
    -- no MATCH_REVIEW yet (a literal would be cast to the enum and refused).
    (CASE r."status"::text
        WHEN 'MATCHED'   THEN 'MATCHED'
        WHEN 'COMPLETED' THEN 'COMPLETED'
        -- Cancelled from MATCH_REVIEW: the current round had already FAILED
        -- (terminal) and the cancel leaves it as it was.
        WHEN 'CANCELLED' THEN CASE WHEN c."previousStatus"::text = 'MATCH_REVIEW' THEN 'FAILED' ELSE 'CANCELLED' END
        WHEN 'EXPIRED'   THEN 'EXPIRED'
        WHEN 'MATCH_REVIEW' THEN 'FAILED'
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
    CASE WHEN r."status" = 'CANCELLED' AND c."previousStatus"::text IS DISTINCT FROM 'MATCH_REVIEW'
         THEN r."cancelledAt" END                        AS "cancelledAt",
    CASE WHEN r."status" = 'EXPIRED'   THEN r."expiredAt"   END AS "expiredAt"
  FROM "ServiceRequest" r
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r."status" IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW') THEN NULL ELSE r."approvedAt" END AS "publishedAt"
  ) p
  CROSS JOIN LATERAL (
    SELECT (r."status" IN ('MATCHED', 'COMPLETED', 'CANCELLED') AND r."matchedOfferId" IS NOT NULL) AS "carries"
  ) m
  LEFT JOIN "Offer" o ON o."id" = r."matchedOfferId"
  LEFT JOIN "ServiceRequestCancellation" c ON c."requestId" = r."id"
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
         CASE WHEN e."status" <> 'FAILED' AND mr."matchedAt" IS DISTINCT FROM e."matchedAt" THEN 'matchedAt' END,
         CASE WHEN e."status" <> 'FAILED' AND mr."matchedOfferId" IS DISTINCT FROM e."matchedOfferId" THEN 'matchedOfferId' END,
         CASE WHEN e."status" <> 'FAILED' AND mr."matchedProviderId" IS DISTINCT FROM e."matchedProviderId" THEN 'matchedProviderId' END,
         CASE WHEN mr."completedAt" IS DISTINCT FROM e."completedAt" THEN 'completedAt' END,
         CASE WHEN mr."cancelledAt" IS DISTINCT FROM e."cancelledAt" THEN 'cancelledAt' END,
         CASE WHEN mr."expiredAt" IS DISTINCT FROM e."expiredAt" THEN 'expiredAt' END,
         CASE WHEN e."status" <> 'FAILED' AND mr."failedAt" IS NOT NULL THEN 'failedAt on a round that did not fail' END)
FROM expected e
JOIN "ServiceRequestMatchRound" mr ON mr."id" = e."currentRoundId"
WHERE mr."status"::text <> e."status"
   OR mr."source"::text <> e."source"
   OR (mr."roundNumber" = 1 AND (
         mr."openedAt" IS DISTINCT FROM e."openedAt"
      OR mr."publishedAt" IS DISTINCT FROM e."publishedAt"
      OR mr."expiresAt" IS DISTINCT FROM e."expiresAt"
      OR mr."reminderSentAt" IS DISTINCT FROM e."reminderSentAt"))
   OR (e."status" <> 'FAILED' AND (
         mr."matchedAt" IS DISTINCT FROM e."matchedAt"
      OR mr."matchedOfferId" IS DISTINCT FROM e."matchedOfferId"
      OR mr."matchedProviderId" IS DISTINCT FROM e."matchedProviderId"
      OR mr."failedAt" IS NOT NULL))
   OR mr."completedAt" IS DISTINCT FROM e."completedAt"
   OR mr."cancelledAt" IS DISTINCT FROM e."cancelledAt"
   OR mr."expiredAt" IS DISTINCT FROM e."expiredAt"

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

UNION ALL
-- 7. A FAILED round carries its own incident — same request, round, offer and
--    provider — and the provider's exclusion from the request names it.
SELECT mr."requestId", 'failed_round_record',
       mr."id" || concat_ws(' ',
         CASE WHEN i."id" IS NULL THEN 'no incident' END,
         CASE WHEN i."id" IS NOT NULL AND (i."roundId" <> mr."id" OR i."requestId" <> mr."requestId") THEN 'incident elsewhere' END,
         CASE WHEN i."offerId" IS DISTINCT FROM mr."matchedOfferId" THEN 'incident offer' END,
         CASE WHEN i."providerId" IS DISTINCT FROM mr."matchedProviderId" THEN 'incident provider' END,
         CASE WHEN x."id" IS NULL THEN 'no exclusion' END,
         CASE WHEN o."status"::text <> 'ACCEPTED' THEN 'winner not ACCEPTED' END)
FROM "ServiceRequestMatchRound" mr
LEFT JOIN "ProviderServiceIncident" i ON i."id" = mr."failureIncidentId"
LEFT JOIN "ServiceRequestProviderExclusion" x
       ON x."incidentId" = mr."failureIncidentId" AND x."requestId" = mr."requestId" AND x."providerId" = mr."matchedProviderId"
LEFT JOIN "Offer" o ON o."id" = mr."matchedOfferId"
WHERE mr."status"::text = 'FAILED'
  AND (i."id" IS NULL OR i."roundId" <> mr."id" OR i."requestId" <> mr."requestId"
       OR i."offerId" IS DISTINCT FROM mr."matchedOfferId" OR i."providerId" IS DISTINCT FROM mr."matchedProviderId"
       OR x."id" IS NULL OR o."status"::text <> 'ACCEPTED')

UNION ALL
-- 8. Every incident is the failure record of its round.
SELECT i."requestId", 'incident_without_failed_round', i."id" || ' → ' || i."roundId"
FROM "ProviderServiceIncident" i
JOIN "ServiceRequestMatchRound" mr ON mr."id" = i."roundId"
WHERE mr."status"::text <> 'FAILED' OR mr."failureIncidentId" IS DISTINCT FROM i."id"

UNION ALL
-- 9. Only the current round may be live: every earlier round ended.
SELECT mr."requestId", 'earlier_round_still_live', mr."id" || ' ' || mr."status"
FROM "ServiceRequestMatchRound" mr
JOIN "ServiceRequest" r ON r."id" = mr."requestId"
WHERE mr."id" <> r."currentRoundId" AND mr."status"::text IN ('OPEN', 'MATCHED')

UNION ALL
-- 10. No excluded provider has an offer in a round after the one they failed.
SELECT x."requestId", 'excluded_provider_offered_again', o."id" || ' in round ' || orr."roundNumber"
FROM "ServiceRequestProviderExclusion" x
JOIN "ServiceRequestMatchRound" src ON src."id" = x."sourceRoundId"
JOIN "Offer" o ON o."requestId" = x."requestId" AND o."providerId" = x."providerId"
JOIN "ServiceRequestMatchRound" orr ON orr."id" = o."matchRoundId"
WHERE orr."roundNumber" > src."roundNumber"

ORDER BY 1, 2;

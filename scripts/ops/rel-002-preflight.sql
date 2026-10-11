-- REL-002 preflight (M1 and M2) — read-only.
--
-- Run before applying the match-round migration (M1) to any database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/rel-002-preflight.sql
--
-- Everything runs inside one READ ONLY transaction and is rolled back. Every
-- "integrity" row must report 0; a non-zero value is a stop: the migration's
-- own verification block would refuse the same data.

BEGIN READ ONLY;

\echo '== _prisma_migrations (applied) =='
SELECT count(*) AS applied_migrations FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

\echo '== ServiceRequest status distribution =='
SELECT status, count(*) FROM "ServiceRequest" GROUP BY status ORDER BY status;

\echo '== Offer status distribution =='
SELECT status, count(*) FROM "Offer" GROUP BY status ORDER BY status;

\echo '== Volumes =='
SELECT
  (SELECT count(*) FROM "ServiceRequest")     AS requests,
  (SELECT count(*) FROM "Offer")              AS offers,
  (SELECT count(*) FROM "ContactRevealEvent") AS contact_reveals,
  (SELECT count(*) FROM "MessageThread")      AS message_threads;

\echo '== Integrity (every value must be 0) =='
SELECT
  -- MATCHED/COMPLETED without the winner it claims.
  (SELECT count(*) FROM "ServiceRequest"
     WHERE status IN ('MATCHED','COMPLETED') AND "matchedOfferId" IS NULL)              AS matched_without_offer,
  -- MATCHED/COMPLETED whose winner is not an ACCEPTED offer.
  (SELECT count(*) FROM "ServiceRequest" r JOIN "Offer" o ON o.id = r."matchedOfferId"
     WHERE r.status IN ('MATCHED','COMPLETED') AND o.status <> 'ACCEPTED')             AS matched_offer_not_accepted,
  -- Any request whose matchedOfferId belongs to another request.
  (SELECT count(*) FROM "ServiceRequest" r JOIN "Offer" o ON o.id = r."matchedOfferId"
     WHERE o."requestId" <> r.id)                                                       AS matched_offer_request_mismatch,
  -- An open-status request still pointing at a winner (would make round 1
  -- disagree with the request projection).
  (SELECT count(*) FROM "ServiceRequest"
     WHERE status IN ('DRAFT','SUBMITTED','IN_REVIEW','APPROVED','REJECTED','EXPIRED')
       AND "matchedOfferId" IS NOT NULL)                                                AS open_status_with_match,
  -- Contact reveal whose request/offer pair disagrees.
  (SELECT count(*) FROM "ContactRevealEvent" e JOIN "Offer" o ON o.id = e."offerId"
     WHERE o."requestId" <> e."requestId")                                              AS reveal_request_offer_mismatch,
  -- Message thread whose request/offer pair disagrees.
  (SELECT count(*) FROM "MessageThread" t JOIN "Offer" o ON o.id = t."offerId"
     WHERE o."requestId" <> t."requestId")                                              AS thread_request_offer_mismatch;

\echo '== Informational (not a stop) =='
SELECT
  (SELECT count(*) FROM "ServiceRequest"
     WHERE status IN ('APPROVED','MATCHED','COMPLETED') AND "approvedAt" IS NULL)      AS live_or_matched_without_approved_at,
  (SELECT count(*) FROM "ServiceRequest"
     WHERE status IN ('MATCHED','COMPLETED') AND "matchedAt" IS NULL)                  AS matched_without_matched_at,
  (SELECT count(*) FROM "ServiceRequest"
     WHERE status = 'CANCELLED' AND "matchedOfferId" IS NOT NULL)                      AS cancelled_with_historical_match,
  (SELECT count(*) FROM "ServiceRequest"
     WHERE "directShowcaseProviderId" IS NOT NULL)                                      AS direct_showcase_gate_set,
  (SELECT count(*) FROM "ServiceRequest"
     WHERE "showcaseLeadId" IS NOT NULL AND "directShowcaseProviderId" IS NULL)        AS released_showcase_leads,
  (SELECT count(*) FROM "ServiceRequest"
     WHERE "directShowcaseProviderId" IS NOT NULL AND "showcaseLeadId" IS NULL)        AS gate_without_lead;

\echo '== Existing unique/partial indexes the later phases touch =='
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('ServiceRequest','Offer','ContactRevealEvent','MessageThread')
  AND (indexdef ILIKE '%UNIQUE%')
ORDER BY tablename, indexname;

\echo '== Match-round objects already present (expected: none before M1) =='
SELECT
  to_regclass('public."ServiceRequestMatchRound"') AS round_table,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'ServiceRequest'     AND column_name = 'currentRoundId')
         OR (table_name = 'Offer'              AND column_name = 'matchRoundId')
         OR (table_name = 'ContactRevealEvent' AND column_name = 'roundId')
         OR (table_name = 'MessageThread'      AND column_name = 'roundId'))) AS round_columns;

\echo '== M2 (Faz 2) integrity — every value must be 0 before 20261011180000_enforce_round_matching_core =='
\echo '   (skip this section before M1: it reads the M1 columns and table)'
SELECT
  (SELECT count(*) FROM "ServiceRequest" WHERE "currentRoundId" IS NULL)              AS request_without_round,
  (SELECT count(*) FROM "Offer" WHERE "matchRoundId" IS NULL)                         AS offer_without_round,
  (SELECT count(*) FROM "ContactRevealEvent" WHERE "roundId" IS NULL)                 AS reveal_without_round,
  (SELECT count(*) FROM "MessageThread" WHERE "roundId" IS NULL)                      AS thread_without_round,
  (SELECT count(*) FROM "ServiceRequest" r
     WHERE (SELECT count(*) FROM "ServiceRequestMatchRound" mr WHERE mr."requestId" = r.id) > 1) AS request_with_several_rounds,
  (SELECT count(*) FROM (SELECT 1 FROM "Offer" GROUP BY "providerId", "matchRoundId" HAVING count(*) > 1) d)
                                                                                      AS duplicate_offer_per_round,
  (SELECT count(*) FROM (SELECT 1 FROM "Offer" WHERE status = 'ACCEPTED' GROUP BY "matchRoundId" HAVING count(*) > 1) d)
                                                                                      AS duplicate_accepted_per_round,
  (SELECT count(*) FROM "ServiceRequestMatchRound" mr JOIN "Offer" o ON o.id = mr."matchedOfferId"
     WHERE o."matchRoundId" <> mr.id)                                                 AS winner_in_other_round,
  -- The per-status round shape M2's CHECKs enforce (same predicate as the
  -- migration's verification block). Non-zero here usually means a legacy
  -- CANCELLED/EXPIRED request without its cancelledAt/expiredAt.
  (SELECT count(*) FROM "ServiceRequestMatchRound" mr
     WHERE NOT (CASE mr.status
       WHEN 'OPEN' THEN mr."matchedOfferId" IS NULL AND mr."matchedProviderId" IS NULL AND mr."matchedAt" IS NULL
                    AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL AND mr."failedAt" IS NULL
       WHEN 'MATCHED' THEN mr."matchedOfferId" IS NOT NULL AND mr."matchedProviderId" IS NOT NULL AND mr."matchedAt" IS NOT NULL
                    AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL AND mr."failedAt" IS NULL
       WHEN 'COMPLETED' THEN mr."matchedOfferId" IS NOT NULL AND mr."matchedProviderId" IS NOT NULL AND mr."matchedAt" IS NOT NULL
                    AND mr."completedAt" IS NOT NULL AND mr."cancelledAt" IS NULL AND mr."expiredAt" IS NULL AND mr."failedAt" IS NULL
       WHEN 'CANCELLED' THEN mr."cancelledAt" IS NOT NULL AND mr."completedAt" IS NULL AND mr."expiredAt" IS NULL AND mr."failedAt" IS NULL
                    AND (mr."matchedOfferId" IS NULL) = (mr."matchedProviderId" IS NULL)
                    AND (mr."matchedOfferId" IS NOT NULL OR mr."matchedAt" IS NULL)
       WHEN 'EXPIRED' THEN mr."expiredAt" IS NOT NULL AND mr."matchedOfferId" IS NULL AND mr."matchedProviderId" IS NULL
                    AND mr."matchedAt" IS NULL AND mr."completedAt" IS NULL AND mr."cancelledAt" IS NULL AND mr."failedAt" IS NULL
       ELSE false END)
        OR (mr."publishedAt" IS NULL) <> (mr."expiresAt" IS NULL))                   AS round_shape_violations;

ROLLBACK;

-- QUALITY-SCORE-001: which quality model wrote a request's score.
--
-- Additive and data-preserving. Every existing row reads 1 — the model that
-- wrote its qualityScore and qualityScoreBreakdown — and keeps both exactly as
-- they are. New requests are written as 2 by the application. Nothing here
-- recomputes a score: moving a row to 2 is the backfill CLI's job
-- (scripts/backfill-quality-score-v2), run separately and on its own approval.
--
-- The CHECK only refuses nonsense (0 or a negative); it does not pin the set
-- of versions, so a later model needs no constraint change.

ALTER TABLE "ServiceRequest"
  ADD COLUMN "qualityScoreVersion" SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE "ServiceRequest"
  ADD CONSTRAINT "ServiceRequest_qualityScoreVersion_check" CHECK ("qualityScoreVersion" >= 1);

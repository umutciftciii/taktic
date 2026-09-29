-- API-HARDENING-001 (2/2 of the follow-up): a promo grant refused because it
-- would take the wallet past the ledger's integer column is an evaluation
-- outcome, not an engine error. Additive only; no row is touched.
ALTER TYPE "CampaignEvaluationOutcome" ADD VALUE 'CREDIT_BALANCE_LIMIT';

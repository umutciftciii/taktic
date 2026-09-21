-- CMP-002 S2B2 (Migration D): campaign lifecycle audit actions.
--
-- Purely additive: five values appended to "CampaignAuditAction". The two
-- existing values keep their position and meaning; no table, column, index
-- or constraint changes, and no row is read, written, converted or seeded.
--
-- ADD VALUE inside the migration's transaction is fine on PostgreSQL 12+ as
-- long as the same transaction does not use the new value, and nothing below
-- does (the add_request_matching and add_promo_credit_consumption migrations
-- set the same precedent).
--
-- The values are written only by the SUPER_ADMIN lifecycle routes this slice
-- adds (activate / pause / resume / end); nothing runs on its own.

ALTER TYPE "CampaignAuditAction" ADD VALUE 'ACTIVATED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'VERSION_ACTIVATED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'PAUSED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'RESUMED';
ALTER TYPE "CampaignAuditAction" ADD VALUE 'ENDED';

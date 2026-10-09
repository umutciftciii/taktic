-- Trigram indexes for the admin search box (ADMIN-SEARCH-INDEX-001).
--
-- ADMIN-SEARCH-TURKISH-HARDENING-001 made the database search Turkish-aware;
-- this makes two of its lists index-backed. Each list ORs a substring match
-- (`ILIKE '%box%'`, `LIKE '%folded%'`) over several columns, and a B-tree
-- serves none of them: the planner read the whole table on every search.
-- A pg_trgm GIN index serves both operators, and when every arm of the OR has
-- one, the planner combines them (BitmapOr) instead of scanning.
--
--   * Finance providers (`/admin/finance/providers`): businessName,
--     businessNameSearch, and — for a caller holding PROVIDERS_READ — phone
--     and email. The exact phone spellings (`phone IN (…)`) already use
--     "ProviderProfile_phone_idx".
--   * Credit ledger (`/admin/finance/credit-ledger`): reason, reasonSearch.
--     The provider arm is resolved on ProviderProfile's indexes above and
--     handed to the ledger as `providerId IN (…)` ("ProviderCreditTransaction_providerId_idx");
--     see FinanceService.ledgerProviderSearchArm.
--
-- Deliberately not indexed: User (the staff list `/admin/users` is already
-- narrowed by "User_role_idx" to a few hundred rows; measured, a trigram
-- BitmapAnd is no faster there). The customer and offer lists read every
-- matching row without pagination; indexing them is ADMIN-SEARCH-PAGINATION-001.
--
-- Each index is declared in schema.prisma as
-- `@@index([col(ops: raw("gin_trgm_ops"))], type: Gin, map: "…")`; `migrate diff`
-- against the schema is empty. pg_trgm is created here and not declared to
-- Prisma (no `postgresqlExtensions` preview feature): Prisma then neither
-- creates nor drops it. pg_trgm is a trusted extension (PostgreSQL 13+), so
-- the database owner may create it without superuser.
--
-- Plain CREATE INDEX (not CONCURRENTLY: Prisma runs a migration in one
-- transaction). It blocks writes to the table while it builds: well under a
-- second for these tables at today's size.
--
-- Rollback (nothing else depends on these objects):
--
--   DROP INDEX "ProviderProfile_businessName_trgm_idx", "ProviderProfile_businessNameSearch_trgm_idx",
--     "ProviderProfile_phone_trgm_idx", "ProviderProfile_email_trgm_idx",
--     "ProviderCreditTransaction_reason_trgm_idx", "ProviderCreditTransaction_reasonSearch_trgm_idx";
--   DROP EXTENSION pg_trgm;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "ProviderProfile_businessName_trgm_idx" ON "ProviderProfile" USING GIN ("businessName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_businessNameSearch_trgm_idx" ON "ProviderProfile" USING GIN ("businessNameSearch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_phone_trgm_idx" ON "ProviderProfile" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderProfile_email_trgm_idx" ON "ProviderProfile" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_reason_trgm_idx" ON "ProviderCreditTransaction" USING GIN ("reason" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProviderCreditTransaction_reasonSearch_trgm_idx" ON "ProviderCreditTransaction" USING GIN ("reasonSearch" gin_trgm_ops);

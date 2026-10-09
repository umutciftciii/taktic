-- Trigram indexes for the customer list's search box (ADMIN-SEARCH-PAGINATION-001).
--
-- `/customers` is now paged by the database: one statement counts the match
-- and another returns one page of it, both with the same WHERE. The search
-- arm of that WHERE ORs four substring matches on "User" — `name ILIKE`,
-- `"nameSearch" LIKE` (the Turkish fold), `email ILIKE`, `phone ILIKE` (plus
-- `phone IN (…)` for a whole number, served by "User_phone_key"). A B-tree
-- serves none of them, so both statements read the whole table. With a
-- pg_trgm GIN index on each arm the planner combines them (BitmapOr).
--
-- Measured on a disposable copy with 120k customers (EXPLAIN ANALYZE of the
-- statements Prisma sends): the count fell from 35–44 ms to 0.2–3 ms and the
-- page from 55–72 ms to 25–27 ms for a name, e-mail or phone search. A box
-- shorter than three characters has no trigram and still scans, as before.
-- The staff list (`/users`) is filtered by role first and keeps
-- "User_role_idx"; its plan is unchanged.
--
-- Deliberately not indexed: the offer list's search. It ORs columns of three
-- tables through LEFT JOINs, a shape no index serves; trigram indexes on the
-- ServiceRequest and ProviderProfile columns were built on the same copy and
-- the planner used none of them.
--
-- pg_trgm is already installed (20261010120000_add_admin_search_trigram_indexes).
-- Plain CREATE INDEX (Prisma runs a migration in one transaction); it blocks
-- writes to "User" while it builds: well under a second at today's size.
--
-- Rollback (nothing depends on these indexes):
--
--   DROP INDEX "User_name_trgm_idx", "User_nameSearch_trgm_idx", "User_email_trgm_idx", "User_phone_trgm_idx";

-- CreateIndex
CREATE INDEX "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_nameSearch_trgm_idx" ON "User" USING GIN ("nameSearch" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_email_trgm_idx" ON "User" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_phone_trgm_idx" ON "User" USING GIN ("phone" gin_trgm_ops);

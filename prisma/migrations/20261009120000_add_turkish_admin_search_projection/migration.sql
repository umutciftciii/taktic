-- Turkish-aware admin search, decided by the database (ADMIN-SEARCH-TURKISH-HARDENING-001).
--
-- The database's default collation is en_US.utf8 on musl (postgres:16.6-alpine,
-- the same image locally, in CI and on staging). Its `lower()`/`ILIKE` fold
-- Ş/Ğ/Ü/Ö/Ç correctly but not the Turkish I pair: `I` folds to `i`, never to
-- `ı`, so an operator typing "ışık" never finds "Işık Müşteri". The four admin
-- lists that search in the database (users, customers, offers, finance) had
-- exactly that gap; the two that search in memory (providers, requests) fold
-- with `tr-TR` and do not.
--
-- What this adds:
--
--   1. `taktic_search_fold(text)` — the one search fold. NFC, whitespace runs
--      collapsed and trimmed, then `lower()` under the ICU Turkish collation
--      (`I`→`ı`, `İ`→`i`). No transliteration: "cagri" does not find "Çağrı".
--      IMMUTABLE, so a stored generated column (and later an index) may use
--      it. The API folds the operator's box with this same function (`SELECT
--      taktic_search_fold($1)`), so there is no second implementation to drift.
--
--   2. One STORED generated column per Turkish free-text column the admin
--      search box reaches. PostgreSQL computes it on every INSERT/UPDATE and
--      refuses a direct write, so no write path can forget or contradict it;
--      ADD COLUMN computes it for every existing row (the backfill), inside
--      this migration's table rewrite. Nullable, never UNIQUE: two people may
--      share a name, and the column only ever answers "does it contain".
--
-- No index and no extension here. A trigram index on these columns is used
-- when it is the only condition, but every list ORs it with `ILIKE` arms that
-- have no index (e-mail, phone, the original column), so the planner scans the
-- table either way; an index nothing uses would only slow writes. Index
-- coverage of the whole search is a separate change.
--
-- Prisma declares each column as `@default(dbgenerated("taktic_search_fold(…)"))`,
-- which is exactly what it reads back from this SQL: `migrate diff` against
-- the schema is empty. Do not regenerate this file with `migrate dev`: Prisma
-- would emit a DEFAULT, which PostgreSQL rejects for an expression over
-- another column.
--
-- Changing the fold later is a new migration that drops and re-adds the
-- columns. `CREATE OR REPLACE FUNCTION` alone would leave every stored value
-- folded the old way.
--
-- Rollback (nothing else depends on these objects):
--
--   ALTER TABLE "User" DROP COLUMN "nameSearch";
--   ALTER TABLE "ProviderProfile" DROP COLUMN "businessNameSearch", DROP COLUMN "contactNameSearch";
--   ALTER TABLE "ServiceRequest" DROP COLUMN "customerNameSearch", DROP COLUMN "citySearch", DROP COLUMN "districtSearch";
--   ALTER TABLE "ProviderCreditTransaction" DROP COLUMN "reasonSearch";
--   DROP FUNCTION taktic_search_fold(text);

-- Every name is schema-qualified: a function used by a generated column must
-- not depend on the caller's search_path. The body is parsed now, so a server
-- without the ICU Turkish collation fails here, before any table is touched.
CREATE FUNCTION taktic_search_fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN pg_catalog.lower(
    pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.normalize(value, 'NFC'), '\s+', ' ', 'g'))
    COLLATE "pg_catalog"."tr-x-icu"
  );

COMMENT ON FUNCTION taktic_search_fold(text) IS
  'Admin search fold: NFC, collapsed whitespace, Turkish lower-case (tr-x-icu). Stored by *Search generated columns; replacing it requires re-adding them.';

ALTER TABLE "User"
  ADD COLUMN "nameSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("name")) STORED;

ALTER TABLE "ProviderProfile"
  ADD COLUMN "businessNameSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("businessName")) STORED,
  ADD COLUMN "contactNameSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("contactName")) STORED;

ALTER TABLE "ServiceRequest"
  ADD COLUMN "customerNameSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("customerName")) STORED,
  ADD COLUMN "citySearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("city")) STORED,
  ADD COLUMN "districtSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("district")) STORED;

ALTER TABLE "ProviderCreditTransaction"
  ADD COLUMN "reasonSearch" TEXT GENERATED ALWAYS AS (taktic_search_fold("reason")) STORED;

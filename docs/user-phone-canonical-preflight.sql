-- Preflight for making `User.phone` canonical at the database (AUTH-REG-001).
--
-- Read-only. Nothing here changes a row; it reports the two facts that decide
-- whether the phone half of "one number, one account" can be moved from the
-- application into the schema the way the e-mail half already was
-- (`User_email_normalized_check`, migration 20260903090000).
--
--   psql "$DATABASE_URL" -f docs/user-phone-canonical-preflight.sql
--
-- Background. Every path that writes `User.phone` now stores E.164
-- (`+90532…`) and looks an incoming number up under every spelling the
-- platform is known to have stored, so no new row can be a second spelling of
-- an existing number. Rows written before that carry whatever was typed:
-- `05321234567`, `5321234567`, `905321234567`. The existing unique index is
-- byte-exact, so it does not see those as one number.
--
-- A CHECK constraint like the e-mail one would refuse to be added while any
-- section-1 row exists; and NOT VALID is not an option, because PostgreSQL
-- enforces a NOT VALID CHECK on every later UPDATE of the row too — a sign-in
-- that stamps `lastLoginAt` on a legacy row would fail. A unique index over a
-- canonical expression would refuse to be built while any section-2 group
-- exists. Both are decisions for a person, row by row: folding a legacy
-- number could collide with another account and would change which account
-- answers to a number. No migration in this repository does that silently.
--
-- Every section that returns no rows is a section that no longer stands in
-- the way. The last section is informational.

\echo '== 1. Non-canonical numbers (BLOCKS a CHECK constraint on the stored form) =='
SELECT
  "id",
  "role",
  "customerOrigin",
  ("passwordHash" IS NOT NULL) AS has_password,
  regexp_replace("phone", '\d', '9', 'g') AS phone_shape,
  length("phone") AS phone_length,
  "createdAt"
FROM "User"
WHERE "phone" IS NOT NULL
  AND "phone" !~ '^\+[1-9]\d{7,14}$'
ORDER BY "createdAt", "id";

\echo '== 2. Two or more accounts on one number (BLOCKS a unique index over the canonical form) =='
WITH canonical AS (
  SELECT
    "id",
    "role",
    "customerOrigin",
    ("passwordHash" IS NOT NULL) AS has_password,
    "createdAt",
    "phone",
    CASE
      WHEN "phone" ~ '^\+[1-9]\d{7,14}$' THEN "phone"
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^00[1-9]\d{7,14}$'
        THEN '+' || substr(regexp_replace("phone", '\D', '', 'g'), 3)
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^90\d{10}$'
        THEN '+' || regexp_replace("phone", '\D', '', 'g')
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^0\d{10}$'
        THEN '+90' || substr(regexp_replace("phone", '\D', '', 'g'), 2)
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^\d{10}$'
        THEN '+90' || regexp_replace("phone", '\D', '', 'g')
      ELSE NULL
    END AS canonical_phone
  FROM "User"
  WHERE "phone" IS NOT NULL
)
SELECT
  c."id",
  c."role",
  c."customerOrigin",
  c.has_password,
  c."createdAt",
  regexp_replace(c."phone", '\d', '9', 'g') AS phone_shape,
  (SELECT count(*) FROM "ServiceRequest" r WHERE r."customerId" = c."id") AS requests,
  dense_rank() OVER (ORDER BY c.canonical_phone) AS number_group
FROM canonical c
WHERE c.canonical_phone IN (
  SELECT canonical_phone FROM canonical
  WHERE canonical_phone IS NOT NULL
  GROUP BY canonical_phone
  HAVING count(*) > 1
)
ORDER BY number_group, c."createdAt", c."id";

\echo '== 3. Numbers no spelling rule recognises (informational: would need a person to read them) =='
SELECT
  "id",
  "role",
  regexp_replace("phone", '\d', '9', 'g') AS phone_shape,
  length("phone") AS phone_length
FROM "User"
WHERE "phone" IS NOT NULL
  AND "phone" !~ '^\+[1-9]\d{7,14}$'
  AND regexp_replace("phone", '\D', '', 'g') !~ '^(00[1-9]\d{7,14}|90\d{10}|0\d{10}|\d{10})$'
ORDER BY "createdAt", "id";

\echo '== 4. Summary (informational) =='
SELECT
  count(*) FILTER (WHERE "phone" IS NOT NULL) AS with_phone,
  count(*) FILTER (WHERE "phone" ~ '^\+[1-9]\d{7,14}$') AS canonical,
  count(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" !~ '^\+[1-9]\d{7,14}$') AS non_canonical,
  count(*) FILTER (WHERE "email" IS NOT NULL AND "email" <> lower(btrim("email"))) AS email_non_normalized
FROM "User";

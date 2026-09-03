-- One address, one kind of account — enforced by the database rather than by
-- every write path remembering to fold before it inserts.
--
-- `User.email` has been UNIQUE since the first migration and a `User` carries
-- exactly one role, so two accounts of different kinds could already never
-- share an address. What was missing is that the index is byte-exact: it keeps
-- `ayse@example.com` and `Ayse@Example.com` apart, so the rule held only for as
-- long as every caller lower-cased first. That is a convention, and a
-- convention is exactly the kind of guard a concurrent pair of registrations —
-- or one path that forgets, or a row written by hand — walks straight through.
--
-- The CHECK below makes the normalised form the only storable form. Combined
-- with the existing unique index that turns "one account per address" into a
-- case- and whitespace-insensitive guarantee, which is the form the product
-- rule is written in.
--
-- Additive, and deliberately so: no column is added, dropped or rewritten, and
-- no row is touched. NULL is admitted unchanged — an account without an address
-- is a state this schema has always allowed, and several exist.
--
-- If this statement fails, the database holds an address that is not in its
-- normalised form. That is data to look at, not data for a migration to
-- silently rewrite: folding it could collide with an existing row and would
-- change which account answers to an address. Find them with
--
--   SELECT id, role FROM "User"
--   WHERE email IS NOT NULL AND email <> lower(btrim(email));
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_normalized_check"
  CHECK ("email" IS NULL OR "email" = lower(btrim("email")));

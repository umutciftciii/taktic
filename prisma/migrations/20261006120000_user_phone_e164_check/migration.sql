-- One telephone number, one account — enforced by the database rather than by
-- every write path remembering to canonicalise before it inserts (AUTH-REG-002).
--
-- `User.phone` has been UNIQUE since the first migration, but the index is
-- byte-exact: `05321234567`, `5321234567` and `+905321234567` are three
-- different keys to it, so one number could hold three accounts. AUTH-REG-001
-- made every application write path store the E.164 form `normalizePhoneNumber`
-- produces; this CHECK makes that the only storable form. Combined with the
-- existing unique index it turns "one account per number" into a guarantee that
-- holds for a concurrent pair of registrations, for a path that forgets, and
-- for a row written by hand. No new index: `User_phone_key` is that index.
--
-- The pattern is the set of values `normalizePhoneNumber` can return
-- (`CANONICAL_PHONE_PATTERN` in apps/api/src/modules/phone-verification/
-- phone.util.ts, held byte-for-byte equal to the literal below by a test). It
-- validates; it does not normalise. Nothing country-specific is added: an
-- international number entered with "+" or "00" stays acceptable.
--
-- NULL is admitted unchanged. An account may exist without a number, and
-- PostgreSQL treats NULLs as distinct in a unique index, so several may.
--
-- Additive, and fail-closed. No row is touched here. If the guard below stops
-- the migration, the database holds a number that is not in its canonical
-- form, and the fix is a reviewed data change — never this file rewriting rows
-- on its own, which could collide two accounts and would decide which of them
-- keeps the number. The reviewed change is
--
--   pnpm --filter @taktic/api canonicalize:user-phones            (dry run)
--   pnpm --filter @taktic/api canonicalize:user-phones -- --apply  [--resolutions FILE]
--
-- and the rows it is about are
--
--   SELECT id, role FROM "User"
--   WHERE phone IS NOT NULL AND phone !~ '^\+[1-9][0-9]{7,14}$';
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
    FROM "User"
   WHERE "phone" IS NOT NULL
     AND "phone" !~ '^\+[1-9][0-9]{7,14}$';

  IF offending > 0 THEN
    RAISE EXCEPTION 'AUTH-REG-002: % User.phone value(s) are not canonical E.164; run canonicalize-user-phones (dry run, then --apply) before this migration', offending
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

ALTER TABLE "User"
  ADD CONSTRAINT "User_phone_e164_check"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$');

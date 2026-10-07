-- SEO-004 PR A: the category illustration stops following the slug.
--
-- The web used to look a category's packaged illustration up by its slug
-- (apps/web/app/category-art.ts), so renaming a slug — which SEO-004 makes a
-- supported operation — silently dropped the picture. The key now lives on the
-- row and does not move when the slug does.
--
-- Controlled backfill, and the only DML of SEO-004:
-- - only the seven slugs the illustrations shipped for;
-- - only rows whose key is still NULL, so a re-run, or a row an operator set
--   some other way, is untouched;
-- - the key is the slug those rows have today, which is exactly what the web
--   looked up until this change, so every category draws what it drew before.
-- A category whose slug is not one of the seven keeps NULL: it had no
-- illustration and still has none.
UPDATE "ServiceCategory"
SET "illustrationKey" = "slug"
WHERE "illustrationKey" IS NULL
  AND "slug" IN (
    'klima-servisi',
    'klima-montaji',
    'kombi-servisi',
    'elektrikci',
    'su-tesisatcisi',
    'boya-badana',
    'ev-temizligi'
  );

-- Vitrin package descriptions that promised "priority in requests".
--
-- A vitrin package buys visibility — a card on the home page and direct leads
-- from it — and nothing else. No package, price or setting ranks a card above
-- another or moves a provider up the general request market, so a description
-- promising that was selling a mechanism that does not exist.
--
-- Additive: nothing is deleted and no column changes. Only descriptions that
-- carry the promise are rewritten, to the sentence that is true of the
-- package, with its own duration in it. Every other description is untouched.
UPDATE "ShowcasePackage"
SET "description" =
  "durationDays"::text || ' gün boyunca vitrin sayfalarında yayınlanın ve kartınızdan doğrudan talep alın.'
WHERE "description" IS NOT NULL
  -- Both spellings stated, because case folding of "Ö" depends on the
  -- database's collation and this must not depend on it.
  AND ("description" ILIKE '%öncelik%' OR "description" LIKE '%Öncelik%');

-- DML, deliberately and narrowly: one row, one column, one exact old value.
--
-- The vitrin package "vitrin-mini-30" was created with a description that
-- promised "priority in requests". A vitrin package buys visibility — a card
-- on the home page and direct leads from it — and nothing else: no package,
-- price or setting ranks a card above another or moves a provider up the
-- general request market. The sentence sold a mechanism that does not exist,
-- and the product asked for it to be corrected.
--
-- What this touches, and only this:
--   table    "ShowcasePackage"
--   column   "description"
--   row      slug = 'vitrin-mini-30' AND description = the exact original text
--            (two lines, CRLF-separated, as the row was created on 2026-09-10)
--   change   description := the corrected sentence
--
-- Exact equality on the old text is the guard: a description an operator has
-- since edited — even by one character — is not this text and is left alone,
-- as is every other vitrin package and every offer/credit package (a different
-- table this statement never names). On a database where the row already
-- carries the corrected text, or where the text differs for any reason, this
-- statement matches nothing and changes nothing.
--
-- Additive: nothing is deleted and no schema changes. The migration keeps the
-- name it was written under; only its predicate was narrowed before it was
-- ever applied to a shared environment.
UPDATE "ShowcasePackage"
SET "description" = '30 gün boyunca vitrin sayfalarında yayınlanın ve kartınızdan doğrudan talep alın.'
WHERE "slug" = 'vitrin-mini-30'
  AND "description" = E'30 gün boyunca vitrinde yer al\r\nTaleplerde öncelik hizmeti';

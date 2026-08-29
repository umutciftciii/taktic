-- Two production-hardening rules the database now holds on its own.
--
-- Additive. One defaulted column, one enum, one CHECK constraint. Nothing is
-- dropped, renamed, rewritten or backfilled, and no existing row changes value.
--
-- 1) status ⇔ isActive parity
--
-- `status` is the canonical publication state and `isActive` is the same fact in
-- the shape every pre-taxonomy client speaks. CategoriesService already writes
-- them together, but a convention is only as strong as the code that remembers
-- it: a seed script, a migration, a psql session or a future endpoint that
-- touched one column alone would produce a category that is ACTIVE and
-- invisible, or DRAFT and public. The first is a service nobody can find; the
-- second is an unreleased service on the public catalogue. Neither should be
-- representable.
--
-- The constraint is stated as an equality rather than as a pair of ORed
-- branches, because that is what it is: `isActive` is true exactly when the
-- status is ACTIVE, so DRAFT and INACTIVE both mean false and no third reading
-- is possible.
--
-- No backfill is needed: the taxonomy migration derived `status` from
-- `isActive` when it added the column, and every write since has gone through
-- CategoriesService. ADD CONSTRAINT validates every existing row, so if a
-- deployment somehow holds a divergent one this migration fails loudly instead
-- of accepting it.
ALTER TABLE "ServiceCategory"
  ADD CONSTRAINT "ServiceCategory_status_isActive_parity"
  CHECK ("isActive" = ("status" = 'ACTIVE'));

-- 2) How a conditional question reads a multi-answer source
--
-- The default is ANY, which is exactly what every rule written before this
-- column meant and still means: "the customer ticked at least one of these".
-- ALL is the new, explicit alternative — "the customer ticked all of these" —
-- and only differs for a MULTI_SELECT source, which is why QuestionsService
-- refuses it on any other kind.
--
-- CreateEnum
CREATE TYPE "QuestionConditionMatchMode" AS ENUM ('ANY', 'ALL');

-- AlterTable
ALTER TABLE "ServiceRequestQuestionCondition" ADD COLUMN     "matchMode" "QuestionConditionMatchMode" NOT NULL DEFAULT 'ANY';

-- Category taxonomy (group / leaf / router), a public-visibility state that is
-- separate from operational readiness, conditional questions, routing rules and
-- the entry category a routed request came in through.
--
-- Additive. Every column added here is either nullable or carries a default
-- that reproduces today's behaviour, both new tables start empty, and no
-- existing row is deleted, renamed or rewritten:
--
--   ServiceCategory.kind       DEFAULT 'LEAF'   — every category that exists
--                                                 today takes requests, which is
--                                                 exactly what LEAF means.
--   ServiceCategory.status     DEFAULT 'ACTIVE' — see the UPDATE below.
--   ServiceRequestQuestion.systemField  NULL    — an ordinary question, answered
--                                                 into ServiceRequestAnswer.
--   ServiceRequestQuestion.isRouter     false   — nothing routes yet.
--   ServiceRequest.entryCategoryId      NULL    — "the entry was the category",
--                                                 which is true of every request
--                                                 created before routing existed.
--                                                 There is no backfill: NULL is
--                                                 the correct, readable answer
--                                                 for those rows, not a gap.
--
-- The one UPDATE is not a backfill of historical data; it is the initialisation
-- of a column that did not exist a statement earlier. `status` and `isActive`
-- are the same fact in two shapes, and the DEFAULT alone would silently promote
-- every deactivated category to ACTIVE. Deriving it from `isActive` is what
-- keeps a category an admin switched off switched off.

-- CreateEnum
CREATE TYPE "ServiceCategoryKind" AS ENUM ('GROUP', 'LEAF', 'ROUTER');

-- CreateEnum
CREATE TYPE "ServiceCategoryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ServiceRequestQuestionSystemField" AS ENUM ('ADDRESS', 'BUDGET', 'DESCRIPTION', 'PREFERRED_DATE');

-- AlterTable
ALTER TABLE "ServiceCategory" ADD COLUMN     "kind" "ServiceCategoryKind" NOT NULL DEFAULT 'LEAF',
ADD COLUMN     "status" "ServiceCategoryStatus" NOT NULL DEFAULT 'ACTIVE';

-- Initialise the new column from the boolean it doubles: an inactive category
-- must not come out of this migration public.
UPDATE "ServiceCategory" SET "status" = 'INACTIVE' WHERE "isActive" = false;

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "entryCategoryId" TEXT;

-- AlterTable
ALTER TABLE "ServiceRequestQuestion" ADD COLUMN     "isRouter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "systemField" "ServiceRequestQuestionSystemField";

-- CreateTable
CREATE TABLE "ServiceCategoryRouterRule" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "targetCategoryId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCategoryRouterRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequestQuestionCondition" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "sourceQuestionId" TEXT NOT NULL,
    "expectedValues" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequestQuestionCondition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceCategoryRouterRule_targetCategoryId_idx" ON "ServiceCategoryRouterRule"("targetCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategoryRouterRule_questionId_optionKey_key" ON "ServiceCategoryRouterRule"("questionId", "optionKey");

-- CreateIndex
CREATE INDEX "ServiceRequestQuestionCondition_sourceQuestionId_idx" ON "ServiceRequestQuestionCondition"("sourceQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestQuestionCondition_questionId_sourceQuestionId_key" ON "ServiceRequestQuestionCondition"("questionId", "sourceQuestionId");

-- CreateIndex
CREATE INDEX "ServiceCategory_status_kind_sortOrder_idx" ON "ServiceCategory"("status", "kind", "sortOrder");

-- CreateIndex
CREATE INDEX "ServiceRequest_entryCategoryId_idx" ON "ServiceRequest"("entryCategoryId");

-- The parent link becomes RESTRICT instead of the implicit SET NULL. Dropping a
-- parent used to orphan its subtree silently; now the database refuses, which
-- is the same answer the API gives with a 409. No row changes value.
-- DropForeignKey
ALTER TABLE "ServiceCategory" DROP CONSTRAINT "ServiceCategory_parentId_fkey";

-- AddForeignKey
ALTER TABLE "ServiceCategory" ADD CONSTRAINT "ServiceCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCategoryRouterRule" ADD CONSTRAINT "ServiceCategoryRouterRule_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ServiceRequestQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCategoryRouterRule" ADD CONSTRAINT "ServiceCategoryRouterRule_targetCategoryId_fkey" FOREIGN KEY ("targetCategoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestQuestionCondition" ADD CONSTRAINT "ServiceRequestQuestionCondition_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ServiceRequestQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestQuestionCondition" ADD CONSTRAINT "ServiceRequestQuestionCondition_sourceQuestionId_fkey" FOREIGN KEY ("sourceQuestionId") REFERENCES "ServiceRequestQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_entryCategoryId_fkey" FOREIGN KEY ("entryCategoryId") REFERENCES "ServiceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

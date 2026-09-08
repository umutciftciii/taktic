-- The record of a provider pulling a submission back out of the review queue.
--
-- Purely additive: one new table, three indexes, three foreign keys. No
-- existing table, column, index or constraint is touched, no row is read or
-- rewritten, and there is no backfill — the table starts empty and stays empty
-- until somebody withdraws something.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why this is not a ShowcaseCardReview
-- ────────────────────────────────────────────────────────────────────────────
--
-- `ShowcaseCardReview.reviewedById` is NOT NULL so that every row in that table
-- is one person's judgement about one text. A withdrawal has no reviewer: it is
-- the author taking their own submission back before anybody ruled on it.
-- Writing it there with a fabricated operator would make "who decided this"
-- unanswerable for every row in that table, which is the same reason
-- ShowcaseCardAutoPublishAudit exists separately.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Why `cardVersionId` is not unique, and why `submittedAtSnapshot` is here
-- ────────────────────────────────────────────────────────────────────────────
--
-- One version may be submitted, withdrawn, corrected, submitted again and
-- withdrawn again. Each of those is a separate event, so a unique index would
-- lose all but one of them.
--
-- Withdrawing clears the version's own `submittedAt` — that is precisely what
-- it does — so the copy taken here is the only thing that says *which*
-- submission a row is about. Without it two withdrawals of one version would be
-- indistinguishable, and the act of withdrawing would destroy the record of
-- what was withdrawn.

-- CreateTable
CREATE TABLE "ShowcaseSubmissionWithdrawal" (
    "id" TEXT NOT NULL,
    "cardVersionId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "submittedAtSnapshot" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcaseSubmissionWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShowcaseSubmissionWithdrawal_cardId_createdAt_idx" ON "ShowcaseSubmissionWithdrawal"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseSubmissionWithdrawal_providerId_createdAt_idx" ON "ShowcaseSubmissionWithdrawal"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "ShowcaseSubmissionWithdrawal_cardVersionId_createdAt_idx" ON "ShowcaseSubmissionWithdrawal"("cardVersionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShowcaseSubmissionWithdrawal" ADD CONSTRAINT "ShowcaseSubmissionWithdrawal_cardVersionId_fkey" FOREIGN KEY ("cardVersionId") REFERENCES "ShowcaseCardVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseSubmissionWithdrawal" ADD CONSTRAINT "ShowcaseSubmissionWithdrawal_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ShowcaseCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShowcaseSubmissionWithdrawal" ADD CONSTRAINT "ShowcaseSubmissionWithdrawal_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Single-use provider application invitations, scoped to one category.
--
-- Fully additive: one new table and nothing else. No column is added to an
-- existing table, nothing is renamed, dropped, rewritten or backfilled, and
-- applying this migration changes no behaviour on its own — until a SUPER_ADMIN
-- issues a link there is not a single row here, and every existing read path
-- returns exactly what it returned before.
--
-- The table is what lets an operator recruit supply for a service the
-- marketplace has not released yet. A DRAFT category is invisible on the public
-- catalogue, in the application form's category list and in provider
-- discovery, so a business has no way to volunteer for one; this is the link
-- that lets exactly one business apply for exactly one such service, once.
--
-- Nothing about the row widens the catalogue. It names a category and grants
-- its holder the right to submit one application against it — not to read the
-- category's description, its question set, its price or who else is behind it.

-- CreateTable
CREATE TABLE "ProviderInviteToken" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderInviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The lookup key, and the only column the raw token is ever represented by:
-- what is stored is sha256(raw) of a 256-bit random value, so a database dump
-- cannot be replayed into an application against an unreleased service.
--
-- Unique because a collision would mean two live links opening the same door.
-- The constraint makes that unrepresentable rather than merely unlikely, and it
-- is also what makes the single-use consume a conditional UPDATE on one row.
CREATE UNIQUE INDEX "ProviderInviteToken_tokenHash_key" ON "ProviderInviteToken"("tokenHash");

-- CreateIndex
-- The admin list: "this category's invitations, newest first". Also the count
-- the release-readiness panel reads, which is this index with a predicate the
-- planner applies on top.
CREATE INDEX "ProviderInviteToken_categoryId_createdAt_idx" ON "ProviderInviteToken"("categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderInviteToken_createdById_idx" ON "ProviderInviteToken"("createdById");

-- CreateIndex
CREATE INDEX "ProviderInviteToken_expiresAt_idx" ON "ProviderInviteToken"("expiresAt");

-- AddForeignKey
-- CASCADE, matching ProviderClaimToken: an invitation is meaningless without
-- the category it names, and a deleted category must not leave a live link
-- pointing at nothing. Deleting a category with children is already refused
-- elsewhere; this only decides what happens to the links of one that goes.
ALTER TABLE "ProviderInviteToken" ADD CONSTRAINT "ProviderInviteToken_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: who issued a link is audit, and losing the audit row
-- because an operator's account was later removed would delete the record of a
-- live invitation along with it.
ALTER TABLE "ProviderInviteToken" ADD CONSTRAINT "ProviderInviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

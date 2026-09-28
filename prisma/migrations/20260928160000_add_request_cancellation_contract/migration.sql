-- ADMIN-DESIGN-001 Faz 3A (PR #118): the request cancellation contract.
--
-- Additive only. No DML, no backfill:
-- - Two permissions. Nothing holds them the moment this runs; a SUPER_ADMIN
--   keeps cancelling implicitly, as it keeps every permission. No role is
--   granted either — who operates cancels is a role-management decision.
-- - One audit table, written by every cancel from now on. Requests cancelled
--   before this migration have no row; nothing is invented for them, and the
--   accepted offers they left ACCEPTED are not rewritten (see the PR report for
--   the read-only query that counts them).
ALTER TYPE "AdminPermission" ADD VALUE 'REQUESTS_CANCEL';
ALTER TYPE "AdminPermission" ADD VALUE 'REQUESTS_CANCEL_WITHOUT_REFUND';

-- CreateEnum
CREATE TYPE "ServiceRequestCancelActor" AS ENUM ('CUSTOMER', 'STAFF');

-- CreateEnum
CREATE TYPE "CancelWinnerRefundDecision" AS ENUM ('NOT_MATCHED', 'REFUNDED', 'WITHHELD', 'NOTHING_TO_REFUND');

-- CreateTable
CREATE TABLE "ServiceRequestCancellation" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorKind" "ServiceRequestCancelActor" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "previousStatus" "ServiceRequestStatus" NOT NULL,
    "acceptedOfferId" TEXT,
    "winnerRefundDecision" "CancelWinnerRefundDecision" NOT NULL,
    "withholdReason" TEXT,
    "closedOfferIds" TEXT[],
    "refundedOfferIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestCancellation_pkey" PRIMARY KEY ("id"),
    -- A withheld refund always carries its reason; nothing else carries one.
    CONSTRAINT "ServiceRequestCancellation_withhold_reason" CHECK (
        ("winnerRefundDecision" = 'WITHHELD') = ("withholdReason" IS NOT NULL AND length(btrim("withholdReason")) > 0)
    ),
    -- Only a matched request has a winner decision other than NOT_MATCHED.
    CONSTRAINT "ServiceRequestCancellation_winner_consistent" CHECK (
        ("acceptedOfferId" IS NULL) = ("winnerRefundDecision" = 'NOT_MATCHED')
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestCancellation_requestId_key" ON "ServiceRequestCancellation"("requestId");

-- AddForeignKey
ALTER TABLE "ServiceRequestCancellation" ADD CONSTRAINT "ServiceRequestCancellation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestCancellation" ADD CONSTRAINT "ServiceRequestCancellation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Customer support tickets.
--
-- Fully additive. Two enums and three new tables; nothing is renamed, dropped,
-- rewritten or backfilled, and no existing row changes value. Every table
-- starts empty on purpose: a ticket is something a customer opens, and there is
-- no historical record anywhere in this database that could be turned into one
-- without inventing a conversation nobody had.
--
-- Every foreign key is RESTRICT, which is the same choice messaging made: a
-- ticket is a permanent record of what was said, so an account with one cannot
-- be deleted out from under it. There is no delete path for a ticket or a
-- message anywhere in the application either.

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTicketAuthorRole" AS ENUM ('CUSTOMER', 'ADMIN');

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorRole" "SupportTicketAuthorRole" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketStatusChange" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromStatus" "SupportTicketStatus",
    "toStatus" "SupportTicketStatus" NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The customer's own list: "my tickets, most recent activity first". The
-- customer column leads because it is also the predicate every authorization
-- query carries.
CREATE INDEX "SupportTicket_customerId_lastActivityAt_idx" ON "SupportTicket"("customerId", "lastActivityAt");

-- CreateIndex
-- The admin list with the status filter applied.
CREATE INDEX "SupportTicket_status_lastActivityAt_idx" ON "SupportTicket"("status", "lastActivityAt");

-- CreateIndex
-- And the admin list with no filter, which orders by the same column alone.
CREATE INDEX "SupportTicket_lastActivityAt_idx" ON "SupportTicket"("lastActivityAt");

-- CreateIndex
-- The only ordering a conversation has: (createdAt, id) ascending, so two
-- messages written in the same millisecond still have exactly one order.
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_id_idx" ON "SupportTicketMessage"("ticketId", "createdAt", "id");

-- CreateIndex
-- The foreign key's own column. PostgreSQL does not index a referencing column
-- for you, and RESTRICT means every write to "User" has to check it.
CREATE INDEX "SupportTicketMessage_authorUserId_createdAt_idx" ON "SupportTicketMessage"("authorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketStatusChange_ticketId_createdAt_id_idx" ON "SupportTicketStatusChange"("ticketId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportTicketStatusChange_changedById_createdAt_idx" ON "SupportTicketStatusChange"("changedById", "createdAt");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketStatusChange" ADD CONSTRAINT "SupportTicketStatusChange_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketStatusChange" ADD CONSTRAINT "SupportTicketStatusChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

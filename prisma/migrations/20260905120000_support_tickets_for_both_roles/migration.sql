-- Support tickets, opened by either side of the marketplace.
--
-- Lossless and explicit. Nothing is dropped, nothing is recreated, and no row
-- is deleted or re-inserted: the ticket table is renamed in place, one column
-- is added and backfilled with the only value that is true of every row that
-- already exists, and one enum gains a member. Every ticket, message, status
-- change, index and foreign key that was here before this migration is still
-- here after it, carrying the same data.
--
-- On staging that means: the existing SupportTicket rows keep their ids, their
-- subjects, their statuses, their timestamps and their owners, and every one of
-- them comes out of this migration marked CUSTOMER — which is what they are,
-- because until now a customer was the only account that could open one. No
-- ticket changes hands, no conversation is rewritten, and no message's author
-- role is touched.

-- ---------------------------------------------------------------------------
-- 1 · The owner column says "account", because that is what it always pointed
--     at. RENAME COLUMN rewrites the catalogue, not the table: the values are
--     the same values, and PostgreSQL carries the column's indexes,
--     constraints and foreign key across with it.
-- ---------------------------------------------------------------------------
ALTER TABLE "SupportTicket" RENAME COLUMN "customerId" TO "requesterId";

-- The index and the foreign key keep their data either way; they are renamed
-- so the schema reads the way the column now does, and so a future
-- `prisma migrate diff` sees the names Prisma would generate rather than
-- proposing to drop and recreate them.
ALTER INDEX "SupportTicket_customerId_lastActivityAt_idx"
  RENAME TO "SupportTicket_requesterId_lastActivityAt_idx";

ALTER TABLE "SupportTicket"
  RENAME CONSTRAINT "SupportTicket_customerId_fkey" TO "SupportTicket_requesterId_fkey";

-- ---------------------------------------------------------------------------
-- 2 · Which side opened it, as a permanent snapshot.
--
--     Added WITH a default so the rows that already exist are filled in the
--     same statement — they are all customers' tickets, because a customer was
--     the only account that could open one — and the default is then dropped,
--     so from here on every insert has to say which desk the ticket belongs to.
--     A column that keeps its default is a column a future create path can
--     forget, and forgetting it would file a provider's ticket as a customer's.
-- ---------------------------------------------------------------------------
CREATE TYPE "SupportTicketRequesterRole" AS ENUM ('CUSTOMER', 'PROVIDER');

ALTER TABLE "SupportTicket"
  ADD COLUMN "requesterRole" "SupportTicketRequesterRole" NOT NULL DEFAULT 'CUSTOMER';

ALTER TABLE "SupportTicket" ALTER COLUMN "requesterRole" DROP DEFAULT;

-- The operator's queue, narrowed to one side of the marketplace — with the
-- status filter and without it. Both orderings end in `lastActivityAt`, which
-- is the only order this list is ever read in.
CREATE INDEX "SupportTicket_requesterRole_status_lastActivityAt_idx"
  ON "SupportTicket"("requesterRole", "status", "lastActivityAt");

CREATE INDEX "SupportTicket_requesterRole_lastActivityAt_idx"
  ON "SupportTicket"("requesterRole", "lastActivityAt");

-- ---------------------------------------------------------------------------
-- 3 · A third author role.
--
--     Purely additive: ADD VALUE appends a member and rewrites no row, so every
--     existing message keeps the CUSTOMER or ADMIN it was written with. PROVIDER
--     is a new value rather than a widening of CUSTOMER precisely so that
--     history stays true — a message written before today really was a
--     customer's.
--
--     Deliberately the last statement that touches this type in this file:
--     PostgreSQL will not let a value added inside a transaction be *used* in
--     the same transaction, and nothing below uses it.
-- ---------------------------------------------------------------------------
ALTER TYPE "SupportTicketAuthorRole" ADD VALUE 'PROVIDER';

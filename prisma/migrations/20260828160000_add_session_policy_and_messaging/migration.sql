-- Session policy ("Beni hatırla") and post-match messaging.
--
-- Fully additive. One defaulted column on an existing table, one new index on
-- an existing column, one enum and two new tables. Nothing is renamed, dropped,
-- rewritten or backfilled, and no existing row changes value.
--
-- Session.rememberMe defaults to false, which is exactly what every session
-- issued before the checkbox existed was: a session nobody asked to be
-- remembered. The idle and absolute clocks themselves need no column — they are
-- read from `lastSeenAt` and `expiresAt`, which this table already had.
--
-- The messaging tables start empty on purpose. A thread is created lazily the
-- first time one of the two matched parties opens messaging, and only where the
-- whole chain holds (MATCHED request, matched offer, ContactRevealEvent, a
-- signed-in customer and a claimed provider account). Inventing threads here
-- for historical matches would create conversations nobody consented to.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "rememberMe" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Session_lastSeenAt_idx" ON "Session"("lastSeenAt");

-- CreateEnum
CREATE TYPE "MessageSenderRole" AS ENUM ('CUSTOMER', 'PROVIDER');

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "customerLastReadAt" TIMESTAMP(3),
    "providerLastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderRole" "MessageSenderRole" NOT NULL,
    "body" TEXT NOT NULL,
    "clientToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One thread per customer match. This is the database-level guarantee behind
-- "a match has exactly one conversation": a second thread on the same request
-- cannot be created even if the application guard were bypassed.
CREATE UNIQUE INDEX "MessageThread_requestId_key" ON "MessageThread"("requestId");

-- CreateIndex
-- And one per offer, so a thread can never be re-pointed at a different winner.
CREATE UNIQUE INDEX "MessageThread_offerId_key" ON "MessageThread"("offerId");

-- CreateIndex
CREATE INDEX "MessageThread_customerUserId_lastMessageAt_idx" ON "MessageThread"("customerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_providerUserId_lastMessageAt_idx" ON "MessageThread"("providerUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_providerId_idx" ON "MessageThread"("providerId");

-- CreateIndex
-- Idempotent sends, per sender. NULLs are distinct in PostgreSQL, so a caller
-- that supplies no key is unprotected rather than colliding with every other
-- keyless message. The sender is part of the key because the two people in a
-- conversation choose their keys independently: scoping it to the thread alone
-- would let one party's send return the other party's message.
CREATE UNIQUE INDEX "Message_threadId_senderUserId_clientToken_key" ON "Message"("threadId", "senderUserId", "clientToken");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_id_idx" ON "Message"("threadId", "createdAt", "id");

-- CreateIndex
-- The rate limiter's scan: "messages this account sent since <cutoff>".
CREATE INDEX "Message_senderUserId_createdAt_idx" ON "Message"("senderUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

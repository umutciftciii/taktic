-- Gated contact sharing: the disclosure acceptance a request carries, and the
-- one-per-request audit row that records a reveal.
--
-- Fully additive: two nullable columns and one new table. Nothing is renamed,
-- dropped or rewritten, and applying this migration changes no behaviour on its
-- own — CONTACT_SHARING_ENABLED defaults to false, and with the flag off no
-- event is ever written and no contact endpoint answers.
--
-- Deliberately NOT backfilled. A request created before these columns existed
-- was never shown the disclosure, so it carries NULL and stays closed even
-- after the feature is switched on. Inventing an acceptance for those customers
-- is exactly what must not happen.

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "contactDisclosureAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "contactDisclosureVersion" TEXT;

-- CreateTable
CREATE TABLE "ContactRevealEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "customerUserId" TEXT,
    "providerId" TEXT NOT NULL,
    "revealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disclosureVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactRevealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One reveal per request. This is the database-level guarantee behind "contact
-- details open exactly once": the accept transaction writes the row, so a
-- second reveal cannot be created even if the application guard were bypassed.
CREATE UNIQUE INDEX "ContactRevealEvent_requestId_key" ON "ContactRevealEvent"("requestId");

-- CreateIndex
-- And one per offer, so an event can never be attributed to two winners.
CREATE UNIQUE INDEX "ContactRevealEvent_offerId_key" ON "ContactRevealEvent"("offerId");

-- CreateIndex
CREATE INDEX "ContactRevealEvent_providerId_idx" ON "ContactRevealEvent"("providerId");

-- CreateIndex
CREATE INDEX "ContactRevealEvent_customerUserId_idx" ON "ContactRevealEvent"("customerUserId");

-- CreateIndex
CREATE INDEX "ContactRevealEvent_revealedAt_idx" ON "ContactRevealEvent"("revealedAt");

-- AddForeignKey
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactRevealEvent" ADD CONSTRAINT "ContactRevealEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

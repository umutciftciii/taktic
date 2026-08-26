-- Attempt history for payment webhook events.
--
-- A provider re-sends an event whose first delivery did not settle. Until now
-- the row recording that first refusal also held the idempotency key, so the
-- redelivery collided with it and rolled back the settlement it should have
-- completed. The row now carries the latest outcome plus the history that
-- outcome would erase, and the redelivery updates it instead of colliding.
--
-- Additive only. Every column is nullable or defaulted, so existing rows keep
-- their meaning: one delivery, handled when the row was created, and — for the
-- refusals among them — a first failure that is exactly the one already stored
-- in "detail".
--
-- Nothing added here is payload. No raw body, no signature, no credential, no
-- correlation token, no buyer detail: only counters, timestamps and the short
-- machine codes the service already writes.

-- AlterTable
ALTER TABLE "PaymentWebhookEvent"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "firstFailureCode" TEXT,
  ADD COLUMN "firstFailureAt" TIMESTAMP(3),
  ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Backfill: the one delivery each existing row represents was handled when the
-- row was created.
UPDATE "PaymentWebhookEvent" SET "lastAttemptAt" = "createdAt";

-- A row already refused carries its first failure in "detail"; a row already
-- settled was resolved when it was written.
UPDATE "PaymentWebhookEvent"
  SET "firstFailureCode" = "detail", "firstFailureAt" = "createdAt"
  WHERE "status" IN ('MISMATCHED', 'IGNORED') AND "detail" IS NOT NULL;

UPDATE "PaymentWebhookEvent"
  SET "resolvedAt" = "createdAt"
  WHERE "status" = 'PROCESSED';

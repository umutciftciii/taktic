-- CMP-006 PR-B — Migration J: package refund requests on a support ticket.
--
-- Additive only. No DML: every existing SupportTicket takes "topic" =
-- 'GENERAL' from the column default, which is the honest backfill — the
-- refund topic did not exist when any of them was opened.
--
-- What the database guarantees on its own (the service is the second fence):
--   1. A refund request is born SUBMITTED, on a PROVIDER ticket owned by the
--      purchase's provider, for that provider's credit-package purchase that
--      carries purchase-terms evidence (insert trigger). A purchase from
--      before the gate can never enter this flow, whatever code path tried.
--   2. Status moves only along the state machine; terminal rows never change;
--      identity columns never change; nothing is deleted (update trigger).
--   3. SETTLED requires the webhook event that settled it; one event settles
--      at most one request; one purchase has at most one SETTLED request and
--      at most one open one (CHECK + unique + partial unique).
--   4. An EXCEPTION approval names a closed-set ground and a reason, and its
--      approver is neither the account that opened the request nor the one
--      that took it into review — with no NULL escape (CHECK).
--   5. No clawback in this slice: "creditClawbackCredits" is pinned to 0.
--   6. The audit table is append-only, and a webhook row names no person.
--
-- The three AdminPermission values are added but not used here (a value added
-- by ALTER TYPE cannot be used in the same transaction).

-- CreateEnum
CREATE TYPE "SupportTicketTopic" AS ENUM ('GENERAL', 'PACKAGE_AND_CREDIT_REFUND');

-- CreateEnum
CREATE TYPE "PackageRefundRequestStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'APPROVED_PENDING_SETTLEMENT', 'SETTLED', 'SETTLEMENT_FAILED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PackageRefundApprovalKind" AS ENUM ('NORMAL', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "PackageRefundExceptionGround" AS ENUM ('STATUTORY_RIGHT', 'UNAUTHORIZED_TRANSACTION', 'DUPLICATE_CHARGE', 'PLATFORM_SERVICE_FAULT');

-- CreateEnum
CREATE TYPE "PackageRefundRequestOrigin" AS ENUM ('PROVIDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PackageRefundAuditAction" AS ENUM ('SUBMITTED', 'REVIEW_STARTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SETTLED', 'SETTLEMENT_FAILED');

-- CreateEnum
CREATE TYPE "PackageRefundActorKind" AS ENUM ('PROVIDER', 'ADMIN', 'PAYMENT_WEBHOOK');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminPermission" ADD VALUE 'PACKAGE_REFUND_READ';
ALTER TYPE "AdminPermission" ADD VALUE 'PACKAGE_REFUND_REQUEST_CREATE';
ALTER TYPE "AdminPermission" ADD VALUE 'PACKAGE_REFUND_APPROVE';

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "topic" "SupportTicketTopic" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "PackageRefundRequest" (
    "id" TEXT NOT NULL,
    "supportTicketId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "PackageRefundRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "origin" "PackageRefundRequestOrigin" NOT NULL,
    "createdById" TEXT NOT NULL,
    "submittedEligibility" JSONB NOT NULL,
    "submittedRecommendation" TEXT NOT NULL,
    "reviewStartedById" TEXT,
    "reviewStartedAt" TIMESTAMP(3),
    "approvalKind" "PackageRefundApprovalKind",
    "exceptionGround" "PackageRefundExceptionGround",
    "exceptionReason" TEXT,
    "approvalEligibility" JSONB,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "settledByWebhookEventId" TEXT,
    "settlementFailedById" TEXT,
    "settlementFailedAt" TIMESTAMP(3),
    "settlementFailureReason" TEXT,
    "creditClawbackCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageRefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageRefundRequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" "PackageRefundAuditAction" NOT NULL,
    "fromStatus" "PackageRefundRequestStatus",
    "toStatus" "PackageRefundRequestStatus" NOT NULL,
    "actorKind" "PackageRefundActorKind" NOT NULL,
    "actorId" TEXT,
    "webhookEventId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageRefundRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackageRefundRequest_supportTicketId_key" ON "PackageRefundRequest"("supportTicketId");

-- CreateIndex
CREATE UNIQUE INDEX "PackageRefundRequest_settledByWebhookEventId_key" ON "PackageRefundRequest"("settledByWebhookEventId");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_status_createdAt_idx" ON "PackageRefundRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_providerId_createdAt_idx" ON "PackageRefundRequest"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_purchaseId_idx" ON "PackageRefundRequest"("purchaseId");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_createdById_idx" ON "PackageRefundRequest"("createdById");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_reviewStartedById_idx" ON "PackageRefundRequest"("reviewStartedById");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_approvedById_idx" ON "PackageRefundRequest"("approvedById");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_rejectedById_idx" ON "PackageRefundRequest"("rejectedById");

-- CreateIndex
CREATE INDEX "PackageRefundRequest_settlementFailedById_idx" ON "PackageRefundRequest"("settlementFailedById");

-- CreateIndex
CREATE UNIQUE INDEX "PackageRefundRequestEvent_webhookEventId_key" ON "PackageRefundRequestEvent"("webhookEventId");

-- CreateIndex
CREATE INDEX "PackageRefundRequestEvent_requestId_createdAt_id_idx" ON "PackageRefundRequestEvent"("requestId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PackageRefundRequestEvent_actorId_idx" ON "PackageRefundRequestEvent"("actorId");

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_supportTicketId_fkey" FOREIGN KEY ("supportTicketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PackagePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_reviewStartedById_fkey" FOREIGN KEY ("reviewStartedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_settlementFailedById_fkey" FOREIGN KEY ("settlementFailedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_settledByWebhookEventId_fkey" FOREIGN KEY ("settledByWebhookEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequestEvent" ADD CONSTRAINT "PackageRefundRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PackageRefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequestEvent" ADD CONSTRAINT "PackageRefundRequestEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageRefundRequestEvent" ADD CONSTRAINT "PackageRefundRequestEvent_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written from here on. Prisma cannot express CHECKs, partial indexes or
-- triggers and does not introspect them, so `migrate diff` stays empty.
-- ---------------------------------------------------------------------------

-- Only a provider's ticket can carry the refund topic.
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_refund_topic_provider_only"
  CHECK ("topic" = 'GENERAL' OR "requesterRole" = 'PROVIDER');

-- No clawback in PR-B (design §0). The next slice widens this on purpose.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_no_clawback"
  CHECK ("creditClawbackCredits" = 0);

-- A request is only ever opened against something with money to return.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_submitted_recommendation"
  CHECK ("submittedRecommendation" IN ('REFUNDABLE', 'EXCEPTION_ONLY'));

ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_review_pair"
  CHECK (("reviewStartedById" IS NULL) = ("reviewStartedAt" IS NULL));

-- Everything past SUBMITTED (bar a withdrawal straight from SUBMITTED) was
-- taken into review by somebody.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_reviewed_states"
  CHECK ("status" IN ('SUBMITTED', 'WITHDRAWN') OR "reviewStartedById" IS NOT NULL);

-- Approval columns exist exactly on the approved states.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_approval_shape"
  CHECK (
    ("status" IN ('APPROVED_PENDING_SETTLEMENT', 'SETTLED', 'SETTLEMENT_FAILED'))
    = ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
       AND "approvalKind" IS NOT NULL AND "approvalEligibility" IS NOT NULL)
    AND ("approvedById" IS NOT NULL OR ("approvedAt" IS NULL AND "approvalKind" IS NULL
         AND "approvalEligibility" IS NULL))
  );

-- An exception names a closed-set ground and a real reason; a normal approval
-- (or none) carries neither.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_exception_shape"
  CHECK (
    CASE
      WHEN "approvalKind" = 'EXCEPTION' THEN
        "exceptionGround" IS NOT NULL
        AND "exceptionReason" IS NOT NULL
        AND char_length(btrim("exceptionReason")) BETWEEN 10 AND 1000
      ELSE "exceptionGround" IS NULL AND "exceptionReason" IS NULL
    END
  );

-- Maker-checker (S0 D5, closed against NULL): an exception approver is
-- neither the opener nor the reviewer. The IS NOT NULL conjuncts are what stop
-- `<>` from evaluating to UNKNOWN on a NULL and passing the CHECK.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_exception_maker_checker"
  CHECK (
    "approvalKind" IS DISTINCT FROM 'EXCEPTION'
    OR (
      "approvedById" IS NOT NULL
      AND "reviewStartedById" IS NOT NULL
      AND "createdById" IS NOT NULL
      AND "approvedById" <> "reviewStartedById"
      AND "approvedById" <> "createdById"
    )
  );

ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_rejected_shape"
  CHECK (
    ("status" = 'REJECTED')
    = ("rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "rejectionReason" IS NOT NULL)
    AND ("rejectionReason" IS NULL OR char_length(btrim("rejectionReason")) BETWEEN 10 AND 1000)
  );

-- SETTLED is a webhook's fact: it exists exactly when a webhook event is named.
ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_settled_by_webhook"
  CHECK (("status" = 'SETTLED') = ("settledByWebhookEventId" IS NOT NULL AND "settledAt" IS NOT NULL));

ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_settlement_failed_shape"
  CHECK (
    ("status" = 'SETTLEMENT_FAILED')
    = ("settlementFailedById" IS NOT NULL AND "settlementFailedAt" IS NOT NULL
       AND "settlementFailureReason" IS NOT NULL)
    AND ("settlementFailureReason" IS NULL
         OR char_length(btrim("settlementFailureReason")) BETWEEN 10 AND 1000)
  );

ALTER TABLE "PackageRefundRequest" ADD CONSTRAINT "PackageRefundRequest_withdrawn_shape"
  CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL));

-- One open request per purchase, and one settled request per purchase.
CREATE UNIQUE INDEX "PackageRefundRequest_one_open_per_purchase"
  ON "PackageRefundRequest" ("purchaseId")
  WHERE "status" IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED_PENDING_SETTLEMENT');

CREATE UNIQUE INDEX "PackageRefundRequest_one_settled_per_purchase"
  ON "PackageRefundRequest" ("purchaseId")
  WHERE "status" = 'SETTLED';

-- The audit row: a webhook row names the event and no person; a person's row
-- names the person and no event. Only a webhook writes SETTLED.
ALTER TABLE "PackageRefundRequestEvent" ADD CONSTRAINT "PackageRefundRequestEvent_actor_shape"
  CHECK (
    ("actorKind" = 'PAYMENT_WEBHOOK') = ("actorId" IS NULL)
    AND ("actorKind" = 'PAYMENT_WEBHOOK') = ("webhookEventId" IS NOT NULL)
    AND ("action" = 'SETTLED') = ("actorKind" = 'PAYMENT_WEBHOOK')
  );

ALTER TABLE "PackageRefundRequestEvent" ADD CONSTRAINT "PackageRefundRequestEvent_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);

-- Trigger: the request's birth. Born SUBMITTED, with no decision on it, on a
-- provider ticket owned by the purchase's provider, for that provider's
-- credit-package purchase bought with purchase-terms evidence. A row that names another provider's purchase or a customer's
-- ticket cannot exist, whichever code path tried.
CREATE FUNCTION "PackageRefundRequest_insert_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purchase_provider TEXT;
  purchase_kind TEXT;
  purchase_evidence BOOLEAN;
  provider_user TEXT;
  ticket_requester TEXT;
  ticket_role TEXT;
BEGIN
  IF NEW."status" <> 'SUBMITTED' OR NEW."reviewStartedById" IS NOT NULL
     OR NEW."approvedById" IS NOT NULL OR NEW."rejectedById" IS NOT NULL
     OR NEW."settledByWebhookEventId" IS NOT NULL OR NEW."settlementFailedById" IS NOT NULL THEN
    RAISE EXCEPTION 'PackageRefundRequest must be created SUBMITTED and undecided'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p."providerId", p."kind"::text,
         (p."termsAcceptanceRequired" AND p."purchaseTermsAcceptanceId" IS NOT NULL)
    INTO purchase_provider, purchase_kind, purchase_evidence
    FROM "PackagePurchase" p WHERE p."id" = NEW."purchaseId";
  SELECT pp."userId" INTO provider_user FROM "ProviderProfile" pp WHERE pp."id" = NEW."providerId";
  SELECT t."requesterId", t."requesterRole"::text INTO ticket_requester, ticket_role
    FROM "SupportTicket" t WHERE t."id" = NEW."supportTicketId";

  IF purchase_provider IS DISTINCT FROM NEW."providerId"
     OR provider_user IS NULL
     OR ticket_role IS DISTINCT FROM 'PROVIDER'
     OR ticket_requester IS DISTINCT FROM provider_user THEN
    RAISE EXCEPTION 'PackageRefundRequest must link the provider''s own purchase and ticket'
      USING ERRCODE = 'check_violation';
  END IF;

  IF purchase_kind IS DISTINCT FROM 'OFFER_PACKAGE' OR purchase_evidence IS NOT TRUE THEN
    RAISE EXCEPTION 'PackageRefundRequest requires a credit-package purchase with purchase-terms evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PackageRefundRequest_insert_guard"
  BEFORE INSERT ON "PackageRefundRequest"
  FOR EACH ROW EXECUTE FUNCTION "PackageRefundRequest_insert_guard_fn"();

-- Trigger: the state machine. No DELETE; identity columns frozen; a terminal
-- row frozen whole; a status change only along an allowed edge. In particular
-- no statement — admin route or hand-written SQL — can reach SETTLED from
-- anything but APPROVED_PENDING_SETTLEMENT, and the CHECK above then demands
-- the webhook event that did it. (TRUNCATE, which only test harnesses issue,
-- does not fire row triggers.)
CREATE FUNCTION "PackageRefundRequest_transition_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PackageRefundRequest rows are never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" IN ('REJECTED', 'SETTLED', 'SETTLEMENT_FAILED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'PackageRefundRequest % is terminal', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."supportTicketId" <> OLD."supportTicketId"
     OR NEW."purchaseId" <> OLD."purchaseId"
     OR NEW."providerId" <> OLD."providerId"
     OR NEW."createdById" <> OLD."createdById"
     OR NEW."origin" <> OLD."origin"
     OR NEW."submittedEligibility" <> OLD."submittedEligibility"
     OR NEW."submittedRecommendation" <> OLD."submittedRecommendation"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'PackageRefundRequest identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('UNDER_REVIEW', 'WITHDRAWN'))
    OR (OLD."status" = 'UNDER_REVIEW' AND NEW."status" IN ('REJECTED', 'APPROVED_PENDING_SETTLEMENT', 'WITHDRAWN'))
    OR (OLD."status" = 'APPROVED_PENDING_SETTLEMENT' AND NEW."status" IN ('SETTLED', 'SETTLEMENT_FAILED'))
  ) THEN
    RAISE EXCEPTION 'PackageRefundRequest cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PackageRefundRequest_transition_guard"
  BEFORE UPDATE OR DELETE ON "PackageRefundRequest"
  FOR EACH ROW EXECUTE FUNCTION "PackageRefundRequest_transition_guard_fn"();

-- Trigger: the audit trail is append-only.
CREATE FUNCTION "PackageRefundRequestEvent_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PackageRefundRequestEvent is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "PackageRefundRequestEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PackageRefundRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION "PackageRefundRequestEvent_append_only_fn"();

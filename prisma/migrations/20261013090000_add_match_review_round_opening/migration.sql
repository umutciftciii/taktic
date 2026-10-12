-- REL-002 Faz 5 (M5): staff recovery of a request in MATCH_REVIEW.
--
-- What this adds:
--
--   * ServiceRequestRoundOpening — the audit and idempotency record of a staff
--     member opening Round N+1 (N >= 3) on a request whose current round
--     FAILED and which therefore sits in MATCH_REVIEW: who, the mandatory
--     internal note, from which failed round, into which new round, the
--     client's idempotency key and when. Append-only;
--   * one AdminPermission value, MATCH_REVIEW_OPEN_ROUND, reserved for
--     SUPER_ADMIN by the application (no role may carry it).
--
-- Why a table and not the round row alone: the new round already says
-- `openedBy = ADMIN` (the enum value has existed since M3), but it has no
-- place for the actor, the note or the idempotency key, and the repository's
-- admin audit is one domain table per kind of act (ADMIN-ACTION-AUDIT-001) —
-- there is no generic log to append to.
--
-- Additive only: a new empty table and an unused enum value. Nothing existing
-- is rewritten and no lock longer than the catalog change is taken on a
-- populated table (the composite FKs validate against an empty table).
--
-- One migration, one transaction. The new AdminPermission value is not used
-- here (ADD VALUE ... IF NOT EXISTS, as M3/M4: PostgreSQL cannot drop an enum
-- value, so scripts/ops/rel-002-m5-rollback.sql leaves it, and a re-deploy
-- after that rollback must not fail on it).
--
-- Irreversibility boundary: while no opening exists the objects below can be
-- dropped by hand (scripts/ops/rel-002-m5-rollback.sql, which refuses
-- otherwise). Once a Round 4+ exists there is no backward schema rollback —
-- the round would lose its audit — and recovery is forward-fix only.

-- AlterEnum
ALTER TYPE "AdminPermission" ADD VALUE IF NOT EXISTS 'MATCH_REVIEW_OPEN_ROUND';

-- CreateTable
CREATE TABLE "ServiceRequestRoundOpening" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fromRoundId" TEXT NOT NULL,
    "openedRoundId" TEXT NOT NULL,
    "openedByAdminId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestRoundOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestRoundOpening_fromRoundId_key" ON "ServiceRequestRoundOpening"("fromRoundId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestRoundOpening_openedRoundId_key" ON "ServiceRequestRoundOpening"("openedRoundId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRequestRoundOpening_idempotencyKey_key" ON "ServiceRequestRoundOpening"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ServiceRequestRoundOpening_requestId_createdAt_idx" ON "ServiceRequestRoundOpening"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceRequestRoundOpening_openedByAdminId_idx" ON "ServiceRequestRoundOpening"("openedByAdminId");

-- AddForeignKey
ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "ServiceRequestRoundOpening_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "ServiceRequestRoundOpening_fromRoundId_requestId_fkey" FOREIGN KEY ("fromRoundId", "requestId") REFERENCES "ServiceRequestMatchRound"("id", "requestId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "ServiceRequestRoundOpening_openedRoundId_requestId_fkey" FOREIGN KEY ("openedRoundId", "requestId") REFERENCES "ServiceRequestMatchRound"("id", "requestId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "ServiceRequestRoundOpening_openedByAdminId_fkey" FOREIGN KEY ("openedByAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw-SQL invariants (Prisma cannot express these) ─────────────────────────

-- The note is mandatory and meaningful: trimmed, 10..2000 characters (the
-- application also collapses whitespace). The two rounds are different rows.
ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "RoundOpening_note_rules"
    CHECK ("note" = btrim("note") AND char_length("note") BETWEEN 10 AND 2000);

ALTER TABLE "ServiceRequestRoundOpening" ADD CONSTRAINT "RoundOpening_distinct_rounds"
    CHECK ("fromRoundId" <> "openedRoundId");

-- The shape at write time: the request was recovered from a FAILED round into
-- the very next round, an OPEN one the staff opened. Written in the same
-- transaction as the round, after it. (MATCH_REVIEW itself is the request's
-- projection; the conditional request update in that transaction is what
-- refuses a second opening, and fromRoundId's unique is the backstop.)
CREATE FUNCTION "service_request_round_opening_shape_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  from_status  text;
  from_number  integer;
  to_status    text;
  to_number    integer;
  to_opened_by text;
BEGIN
  SELECT r."status"::text, r."roundNumber" INTO from_status, from_number
  FROM "ServiceRequestMatchRound" r WHERE r."id" = NEW."fromRoundId" AND r."requestId" = NEW."requestId";
  SELECT r."status"::text, r."roundNumber", r."openedBy"::text INTO to_status, to_number, to_opened_by
  FROM "ServiceRequestMatchRound" r WHERE r."id" = NEW."openedRoundId" AND r."requestId" = NEW."requestId";

  IF from_status IS DISTINCT FROM 'FAILED' THEN
    RAISE EXCEPTION 'ROUND_OPENING_SHAPE: round % is % (FAILED expected)', NEW."fromRoundId", from_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF to_status IS DISTINCT FROM 'OPEN' OR to_opened_by IS DISTINCT FROM 'ADMIN'
     OR to_number IS DISTINCT FROM from_number + 1 THEN
    RAISE EXCEPTION 'ROUND_OPENING_SHAPE: round % (%, %, number %) does not follow % as an ADMIN round',
      NEW."openedRoundId", to_status, to_opened_by, to_number, NEW."fromRoundId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServiceRequestRoundOpening_shape"
  BEFORE INSERT ON "ServiceRequestRoundOpening"
  FOR EACH ROW EXECUTE FUNCTION "service_request_round_opening_shape_fn"();

-- Openings are never edited or removed. TRUNCATE (test reset) does not fire
-- row triggers.
CREATE FUNCTION "service_request_round_opening_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ServiceRequestRoundOpening rows are append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ServiceRequestRoundOpening_append_only"
  BEFORE UPDATE OR DELETE ON "ServiceRequestRoundOpening"
  FOR EACH ROW EXECUTE FUNCTION "service_request_round_opening_append_only_fn"();

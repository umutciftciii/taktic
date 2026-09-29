-- API-HARDENING-001 (1/4): who cancelled a paid vitrin run.
--
-- Additive only. No existing row is touched and no backfill runs: placements
-- cancelled before this migration have no recorded actor, and inventing one
-- would be a false audit record.

CREATE TABLE "ShowcasePlacementCancellation" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowcasePlacementCancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowcasePlacementCancellation_placementId_key" ON "ShowcasePlacementCancellation"("placementId");

CREATE INDEX "ShowcasePlacementCancellation_actorUserId_createdAt_idx" ON "ShowcasePlacementCancellation"("actorUserId", "createdAt");

ALTER TABLE "ShowcasePlacementCancellation" ADD CONSTRAINT "ShowcasePlacementCancellation_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "ShowcasePlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShowcasePlacementCancellation" ADD CONSTRAINT "ShowcasePlacementCancellation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A cancellation record is only meaningful for a placement that is cancelled.
-- Checked on insert: the row and the status change are written together, in
-- that order, by the only code path that cancels a run.
CREATE FUNCTION "ShowcasePlacementCancellation_insert_guard_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ShowcasePlacement"
    WHERE "id" = NEW."placementId" AND "status" = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'ShowcasePlacementCancellation requires a CANCELLED placement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ShowcasePlacementCancellation_insert_guard"
  BEFORE INSERT ON "ShowcasePlacementCancellation"
  FOR EACH ROW EXECUTE FUNCTION "ShowcasePlacementCancellation_insert_guard_fn"();

-- The audit trail is append-only.
CREATE FUNCTION "ShowcasePlacementCancellation_append_only_fn"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ShowcasePlacementCancellation is append-only (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "ShowcasePlacementCancellation_append_only"
  BEFORE UPDATE OR DELETE ON "ShowcasePlacementCancellation"
  FOR EACH ROW EXECUTE FUNCTION "ShowcasePlacementCancellation_append_only_fn"();

-- Provider self-enrollment, off by default so nothing recruits by accident.
-- A category an operator has not opened is invisible to applicants, which is
-- what makes the enrollment catalogue safe to serve without a session.
ALTER TABLE "ServiceCategory"
  ADD COLUMN "providerEnrollmentOpen" BOOLEAN NOT NULL DEFAULT false;

-- Live services keep the state they already had: a provider has always been
-- able to select an ACTIVE leaf. The stored value matters if one of these is
-- ever pulled back to DRAFT, where the column is what decides enrollment.
UPDATE "ServiceCategory"
   SET "providerEnrollmentOpen" = true
 WHERE "status" = 'ACTIVE' AND "kind" = 'LEAF';

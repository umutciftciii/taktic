-- CreateEnum
CREATE TYPE "CustomerOrigin" AS ENUM ('REGISTERED', 'AUTO_CREATED_REQUEST', 'ADMIN_CREATED', 'IMPORTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "customerOrigin" "CustomerOrigin";

-- Backfill existing CUSTOMER users from their auth state.
-- Users that registered (have a passwordHash) → REGISTERED.
-- Users that were auto-created during service request submission (no passwordHash) → AUTO_CREATED_REQUEST.
-- Non-customer roles stay NULL.
UPDATE "User"
SET "customerOrigin" =
  CASE
    WHEN "role" = 'CUSTOMER' AND "passwordHash" IS NOT NULL THEN 'REGISTERED'::"CustomerOrigin"
    WHEN "role" = 'CUSTOMER' AND "passwordHash" IS NULL THEN 'AUTO_CREATED_REQUEST'::"CustomerOrigin"
    ELSE NULL
  END
WHERE "role" = 'CUSTOMER';

-- Vitrin phase two, step 4 of 7: the lead's four enum types, on their own.
--
-- Separate from the table that uses them for a PostgreSQL reason rather than a
-- stylistic one. A newly created type is usable in the same transaction, but
-- keeping type creation and the DDL that consumes it in one file is the shape
-- that breaks the moment a later migration has to *extend* one of them —
-- `ALTER TYPE … ADD VALUE` must commit before the new value can be used. The
-- split is here so the pattern is the same in both cases.
--
-- Purely additive, and no table changes at all.

-- CreateEnum
CREATE TYPE "ShowcaseLeadUrgency" AS ENUM ('URGENT', 'NORMAL');

-- CreateEnum
CREATE TYPE "ShowcaseLeadStatus" AS ENUM ('OPEN', 'ANSWERED', 'BREACHED', 'RELEASED', 'CLOSED_UNANSWERED');

-- CreateEnum
CREATE TYPE "ShowcaseLeadFallbackDecision" AS ENUM ('RELEASE', 'KEEP_CLOSED');

-- CreateEnum
CREATE TYPE "ShowcaseLeadCloseReason" AS ENUM ('CUSTOMER_KEPT_CLOSED', 'CUSTOMER_CANCELLED', 'MODERATION_REJECTED', 'REQUEST_EXPIRED');

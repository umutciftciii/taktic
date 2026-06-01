-- Normalize historical Offer and ServiceRequest budget values to minor-unit currency integers.
-- After this migration, the system contract is: every monetary integer column stores the value
-- in the currency's minor unit (e.g. kuruş for TRY, cents for USD/EUR). UI helpers format these
-- minor-unit integers back to a human readable string with two fractional digits.
--
-- IMPORTANT: OfferCreditPackage.priceAmount and PackagePurchase.priceAmountSnapshot are already
-- stored as minor units (see prisma/seed.ts, e.g. starter-20 = 49900 kuruş = 499,00 TRY). They
-- MUST NOT be multiplied again — doing so would corrupt every existing package and snapshot.
--
-- This migration is intended to run exactly once. Prisma's _prisma_migrations bookkeeping table
-- already prevents re-application, so no application-level guard is necessary. Do not edit this
-- file after it has been applied; create a follow-up migration instead.

UPDATE "Offer"
SET "priceAmount" = "priceAmount" * 100;

UPDATE "ServiceRequest"
SET "budgetMin" = "budgetMin" * 100
WHERE "budgetMin" IS NOT NULL;

UPDATE "ServiceRequest"
SET "budgetMax" = "budgetMax" * 100
WHERE "budgetMax" IS NOT NULL;

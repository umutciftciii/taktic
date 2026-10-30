-- SEC-AUTH-ABUSE-001: persistent, cross-process failed sign-in counters.
--
-- Additive: a new table and nothing else. No existing row, session or account
-- is touched, so every account keeps its password and every session stays
-- valid. The in-memory throttler stays where it was; this table is what makes
-- the account lock survive a restart and hold across API instances.
--
-- Keys are SHA-256 digests (login-attempts.service.ts), never an e-mail or an
-- address. Rows are short-lived: the service deletes rows idle for a day.
CREATE TABLE "AuthAttemptCounter" (
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "accountKeyHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAttemptCounter_pkey" PRIMARY KEY ("scope","keyHash"),
    CONSTRAINT "AuthAttemptCounter_scope_check" CHECK ("scope" IN ('ACCOUNT', 'IP', 'IP_ACCOUNT')),
    CONSTRAINT "AuthAttemptCounter_attempts_check" CHECK ("attempts" >= 0)
);

CREATE INDEX "AuthAttemptCounter_accountKeyHash_idx" ON "AuthAttemptCounter"("accountKeyHash");
CREATE INDEX "AuthAttemptCounter_updatedAt_idx" ON "AuthAttemptCounter"("updatedAt");

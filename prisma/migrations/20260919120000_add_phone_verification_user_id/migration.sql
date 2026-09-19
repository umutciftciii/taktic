-- Account-level phone codes (AUTH-PROVIDER-CONTACT-001). A code that proves an
-- account's own number, outside any request, needs a home in the table the
-- request and vitrin codes already live in — and a column that keeps it apart
-- from both, so an account's consumed code can never be redeemed as a lead's
-- proof. Additive and nullable, nothing backfilled: every row written before
-- this column was a request code or a lead code, and reads as one.
ALTER TABLE "PhoneVerification" ADD COLUMN "userId" TEXT;

ALTER TABLE "PhoneVerification" ADD CONSTRAINT "PhoneVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PhoneVerification_userId_createdAt_idx" ON "PhoneVerification"("userId", "createdAt");

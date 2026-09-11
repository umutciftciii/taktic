-- Marks a verification that was completed with the local/staging test code
-- rather than the code that was sent. Additive: a boolean defaulting to
-- false, so every existing row reads as the real verification it was.
ALTER TABLE "PhoneVerification"
  ADD COLUMN "verifiedByTestBypass" BOOLEAN NOT NULL DEFAULT false;

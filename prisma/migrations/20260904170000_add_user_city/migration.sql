-- The province a customer keeps on their account, so the profile screen has
-- somewhere to put it. Nullable with no backfill: nobody has ever been asked
-- for it, and inventing one from a past request would be a guess presented as
-- a fact the customer typed.
ALTER TABLE "User" ADD COLUMN "city" TEXT;

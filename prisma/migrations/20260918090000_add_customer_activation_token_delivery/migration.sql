-- AUTH-EMAIL-001: how an activation link travelled, recorded on the token at
-- issue time. Additive and nullable: nothing is backfilled, so every token
-- issued before this column existed reads as "delivery unknown", and an
-- unknown delivery never stamps User.emailVerifiedAt when consumed. No index
-- — the column is only ever read on the token row already found by its hash.
CREATE TYPE "CustomerActivationDelivery" AS ENUM ('EMAIL_DELIVERY', 'ADMIN_LINK');

ALTER TABLE "CustomerActivationToken" ADD COLUMN "delivery" "CustomerActivationDelivery";

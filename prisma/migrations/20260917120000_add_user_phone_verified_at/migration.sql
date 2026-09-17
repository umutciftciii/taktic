-- Account-level proof of the telephone number (AUTH-PHONE-001). Additive and
-- nullable: nothing is backfilled, so every existing account reads as "no
-- proof on file" and earns one at its next real verification. No index — the
-- column is only ever read by primary key alongside `phone`.
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

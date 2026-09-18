-- AUTH-EMAIL-001 — read-only report of e-mail proofs that may have come from an
-- operator's activation link rather than from the mailbox.
--
-- Before this fix, consuming ANY customer activation link stamped
-- User.emailVerifiedAt, including a link an operator generated on the admin
-- screen (CustomerActivationToken.createdById IS NOT NULL) and handed over by
-- hand. Such a stamp is not proof of the mailbox.
--
-- This query LISTS the accounts where the proof coincides with the consumption
-- of an operator-issued link and no mailed proof exists for the address. It is
-- a report for a human decision, not a cleanup: the match rests on timestamp
-- equality, which is evidence, not a record of provenance, so nothing here
-- (or anywhere in the codebase) rewrites these rows automatically. Tokens
-- issued after the fix carry `delivery`, and a mailed one can be told apart
-- without this heuristic.
--
-- Read-only. Run with a read-only role or inside a transaction you ROLLBACK.
SELECT
  u."id"                        AS "userId",
  u."email",
  u."emailVerifiedAt",
  t."usedAt"                    AS "adminLinkUsedAt",
  t."createdById"               AS "issuedByAdminId",
  t."delivery"                  AS "tokenDelivery",
  EXISTS (
    SELECT 1 FROM "EmailVerificationToken" ev
    WHERE ev."userId" = u."id" AND ev."usedAt" IS NOT NULL
  )                             AS "hasMailedVerification",
  EXISTS (
    SELECT 1 FROM "CustomerActivationToken" m
    WHERE m."customerId" = u."id"
      AND m."usedAt" = u."emailVerifiedAt"
      AND m."createdById" IS NULL
  )                             AS "hasMailedActivationAtSameInstant"
FROM "User" u
JOIN "CustomerActivationToken" t
  ON t."customerId" = u."id"
 AND t."usedAt" = u."emailVerifiedAt"
 AND t."createdById" IS NOT NULL
WHERE u."emailVerifiedAt" IS NOT NULL
ORDER BY u."emailVerifiedAt" DESC;

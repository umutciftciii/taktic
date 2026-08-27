-- Manual retry bookkeeping for NotificationLog.
--
-- Additive only: two nullable/defaulted columns, no data rewritten and nothing
-- dropped. Existing rows keep the single attempt they really had (attemptCount
-- defaults to 1) and report no lastAttemptAt, which is true — the column did
-- not exist when they were written.
--
-- Neither column widens what this table holds: one is a counter, the other a
-- timestamp. No body, no token, no recipient.
ALTER TABLE "NotificationLog" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "NotificationLog" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

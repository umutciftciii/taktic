-- Additive only: one index. No column is added, no row is written, read or
-- deleted, and nothing about an existing NotificationLog row changes.

-- The request-expiry outbox sweep runs on every tick of that job and asks one
-- question: "are there PENDING rows for these two templates whose claim is
-- absent or stale?" Without an index that is a scan of every PENDING row the
-- table has ever held.
--
-- "template" leads because it is the selective column — two templates out of
-- twenty-eight — and "lastAttemptAt" is carried so both halves of the
-- predicate, the never-attempted rows and the ones whose claim lease has
-- expired, are answered from the index.
CREATE INDEX "NotificationLog_template_status_lastAttemptAt_idx"
    ON "NotificationLog"("template", "status", "lastAttemptAt");

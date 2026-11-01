-- OBS-ALERT-002 rollback report — read-only, counts only.
--
-- Shows the operator how many e-mail deliveries are bound to a managed
-- recipient and still open. OBS-ALERT-001 does not know recipients; it would
-- send such a row to OPS_ALERT_EMAIL — one reason running the previous API
-- image on this schema (R2 in scripts/ops/obs-alert-002-rollback.md) is not
-- supported.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/obs-alert-002-rollback-report.sql
--
-- The `expected` row is the exact value to pass to the cancel script as
-- -v expected='…'. Nothing is written (the transaction is READ ONLY) and no
-- address, masked address, ciphertext, HMAC or row id is printed: every value
-- is a count, the routing mode or that one line.

\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

-- report:begin
SELECT section, item, value
FROM (
  -- Recipient-bound e-mail deliveries the cancel script would cancel.
  SELECT 1 AS ord, s.n AS n, 'open_recipient_deliveries' AS section, s.status AS item,
         (SELECT count(*) FROM "OpsAlertDelivery" d
           WHERE d."recipientId" IS NOT NULL AND d.status::text = s.status)::text AS value
  FROM (VALUES ('PENDING', 1), ('FAILED', 2), ('SENDING', 3)) AS s(status, n)
  UNION ALL
  SELECT 2, 0, 'expected', 'line',
         format('PENDING=%s,FAILED=%s,SENDING=%s',
           count(*) FILTER (WHERE d.status = 'PENDING'),
           count(*) FILTER (WHERE d.status = 'FAILED'),
           count(*) FILTER (WHERE d.status = 'SENDING'))
  FROM "OpsAlertDelivery" d
  WHERE d."recipientId" IS NOT NULL AND d.status IN ('PENDING', 'FAILED', 'SENDING')
  UNION ALL
  -- Legacy rows (OPS_ALERT_EMAIL / Telegram) for context: the old code sends
  -- these itself, and the cancel script never touches them.
  SELECT 3, s.n, 'open_legacy_deliveries', s.status,
         (SELECT count(*) FROM "OpsAlertDelivery" d
           WHERE d."recipientId" IS NULL AND d.status::text = s.status)::text
  FROM (VALUES ('PENDING', 1), ('FAILED', 2), ('SENDING', 3)) AS s(status, n)
  UNION ALL
  SELECT 4, 0, 'routing', 'emailRouting',
         COALESCE((SELECT "emailRouting"::text FROM "OpsAlertRoutingSettings" WHERE id = 'ops-alert-routing'), 'NO_ROW')
  UNION ALL
  SELECT 5, s.n, 'recipients_by_status', s.status,
         (SELECT count(*) FROM "OpsAlertRecipient" r WHERE r.status::text = s.status)::text
  FROM (VALUES ('ACTIVE', 1), ('PAUSED', 2), ('DELETED', 3)) AS s(status, n)
  UNION ALL
  SELECT 6, 0, 'live_recipients_by_key_id', r."addressKeyId", count(*)::text
  FROM "OpsAlertRecipient" r
  WHERE r.status <> 'DELETED'
  GROUP BY r."addressKeyId"
  UNION ALL
  SELECT 7, 0, 'live_recipients_by_hmac_version', r."addressHmacVersion"::text, count(*)::text
  FROM "OpsAlertRecipient" r
  WHERE r.status <> 'DELETED'
  GROUP BY r."addressHmacVersion"
) AS report
ORDER BY ord, n, item;
-- report:end

ROLLBACK;

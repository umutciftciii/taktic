-- OBS-ALERT-002 rollback cancel — count-confirmed.
--
-- Step R2.4 of scripts/ops/obs-alert-002-rollback.md. Cancels the e-mail
-- deliveries that are bound to a managed recipient and still open (PENDING,
-- FAILED, SENDING), so the OBS-ALERT-001 code (d7c195a2) — which does not know
-- recipients — cannot send them to OPS_ALERT_EMAIL. Legacy rows
-- (recipientId NULL: OPS_ALERT_EMAIL and Telegram) are not touched.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v expected='PENDING=<n>,FAILED=<n>,SENDING=<n>' \
--     -f scripts/ops/obs-alert-002-rollback-cancel.sql
--
-- `expected` is the `expected` line of obs-alert-002-rollback-report.sql, as
-- the operator approved it. The script refuses, changing nothing, when:
--   * expected is missing or not exactly PENDING=<n>,FAILED=<n>,SENDING=<n>;
--   * email routing is MANAGED — revert to ENV_LEGACY first with the panel's
--     revert (POST ops-alerts/routing/revert/preview, then .../revert:
--     applyRevert), which also unbinds or cancels these rows itself;
--   * the counts it finds are not exactly the expected ones ('counts changed').
-- Otherwise, in one transaction, the rows become CANCELLED with errorCode
-- ROLLED_BACK and lose their claim (a worker that is mid-send finds nothing
-- to write its outcome to). Run with the API stopped.

\set ON_ERROR_STOP on

\if :{?expected}
SELECT set_config('obs_alert_002.expected', :'expected', false);
\endif

BEGIN;

DO $cancel$
DECLARE
  raw text := current_setting('obs_alert_002.expected', true);
  wanted text[];
  mode text;
  got_pending bigint;
  got_failed bigint;
  got_sending bigint;
BEGIN
  wanted := regexp_match(COALESCE(raw, ''), '^PENDING=([0-9]{1,9}),FAILED=([0-9]{1,9}),SENDING=([0-9]{1,9})$');
  IF wanted IS NULL THEN
    RAISE EXCEPTION 'obs-alert-002 cancel refused: expected counts are required as -v expected=''PENDING=<n>,FAILED=<n>,SENDING=<n>'' (the expected line of obs-alert-002-rollback-report.sql)';
  END IF;

  SELECT "emailRouting"::text INTO mode
    FROM "OpsAlertRoutingSettings" WHERE id = 'ops-alert-routing' FOR UPDATE;
  IF mode = 'MANAGED' THEN
    RAISE EXCEPTION 'obs-alert-002 cancel refused: email routing is MANAGED; revert to ENV_LEGACY first (admin panel revert, i.e. applyRevert), then run the report again';
  END IF;

  -- Cancel and count in one statement, then compare: a mismatch raises and
  -- the whole block — the update included — is rolled back.
  WITH target AS (
    SELECT id, status FROM "OpsAlertDelivery"
     WHERE "recipientId" IS NOT NULL AND status IN ('PENDING', 'FAILED', 'SENDING')
     FOR UPDATE
  ), cancelled AS (
    UPDATE "OpsAlertDelivery" d
       SET status = 'CANCELLED', "errorCode" = 'ROLLED_BACK',
           "claimToken" = NULL, "claimedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      FROM target t
     WHERE d.id = t.id
    RETURNING t.status AS was
  )
  SELECT count(*) FILTER (WHERE was = 'PENDING'),
         count(*) FILTER (WHERE was = 'FAILED'),
         count(*) FILTER (WHERE was = 'SENDING')
    INTO got_pending, got_failed, got_sending
    FROM cancelled;

  IF got_pending <> wanted[1]::bigint OR got_failed <> wanted[2]::bigint OR got_sending <> wanted[3]::bigint THEN
    RAISE EXCEPTION 'obs-alert-002 cancel refused: counts changed (expected %, found PENDING=%,FAILED=%,SENDING=%); nothing was cancelled, run the report again',
      raw, got_pending, got_failed, got_sending;
  END IF;

  RAISE NOTICE 'obs-alert-002 cancel: cancelled PENDING=%,FAILED=%,SENDING=% (errorCode ROLLED_BACK)',
    got_pending, got_failed, got_sending;
END
$cancel$;

COMMIT;

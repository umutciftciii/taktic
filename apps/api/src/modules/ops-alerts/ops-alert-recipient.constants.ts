/** Live (not DELETED) operations-alert recipients the database allows. */
export const OPS_ALERT_RECIPIENT_LIMIT = 10;

/**
 * pg_advisory_xact_lock key the recipient-limit trigger takes before it
 * counts, so two inserts racing for the last slot are serialised. The same
 * value (190455298 in decimal) is written into the trigger in the OBS-ALERT-002 migration; the two
 * must change together. Distinct from OPS_ALERT_ADVISORY_LOCK_KEY (the
 * evaluator's lock).
 */
export const OPS_ALERT_RECIPIENT_LOCK_KEY = 0x0b5a1e02;

/** The one OpsAlertRoutingSettings row (its migration creates it; a CHECK pins the id). */
export const OPS_ALERT_ROUTING_ID = 'ops-alert-routing';

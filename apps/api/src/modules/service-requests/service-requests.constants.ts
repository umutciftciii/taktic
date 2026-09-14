function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The IP budget for `POST /service-requests`, enforced by
 * ServiceRequestThrottlerGuard as the `service-requests` named throttler on
 * AuthModule's shared `ThrottlerModule.forRoot` (see the comment there).
 *
 * Overridable from the environment — mirroring AUTH_RATE_LIMIT_MAX /
 * AUTH_RATE_LIMIT_WINDOW_SECONDS — because the end-to-end suite legitimately
 * creates dozens of requests from 127.0.0.1 within minutes and needs to raise
 * this the same way it already raises the login budget (see
 * e2e/playwright.config.ts). Unlike the per-phone limits below, this one is a
 * deployment tuning value, not a product rule, so it is allowed to move.
 */
export const SERVICE_REQUEST_THROTTLE_TTL_MS =
  positiveInt(process.env.SERVICE_REQUEST_RATE_LIMIT_WINDOW_SECONDS, 600) * 1000;
export const SERVICE_REQUEST_THROTTLE_LIMIT = positiveInt(
  process.env.SERVICE_REQUEST_RATE_LIMIT_MAX,
  5,
);

/**
 * The per-phone limits enforced inside `createServiceRequest`'s own
 * transaction, not by the throttler above: they count rows for one
 * `customerPhone`, regardless of which IP submitted them. Hard-coded —
 * these are the product's own rule about how many requests one phone number
 * may have in flight, not a deployment knob.
 */
export const SERVICE_REQUEST_MAX_PER_PHONE_PER_DAY = 5;
export const SERVICE_REQUEST_MAX_OPEN_PER_PHONE = 10;

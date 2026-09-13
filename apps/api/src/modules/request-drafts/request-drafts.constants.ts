function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const REQUEST_DRAFT_COOKIE_NAME = 'taktic_request_draft';
export const REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_DRAFT_MAX_PAYLOAD_BYTES = 32 * 1024;
export const REQUEST_DRAFT_MAX_ACTIVE = positiveInt(process.env.REQUEST_DRAFT_MAX_ACTIVE, 10_000);
export const REQUEST_DRAFT_THROTTLE_TTL_MS = 10 * 60 * 1000;
export const REQUEST_DRAFT_THROTTLE_LIMIT = 5;
export const REQUEST_DRAFT_SWEEP_BATCH = 200;
export const REQUEST_DRAFT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

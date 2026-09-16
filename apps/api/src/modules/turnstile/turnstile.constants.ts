import turnstile from '@taktic/shared/turnstile.json';

/**
 * The names both sides of the wire agree on, read from the one JSON file the
 * web application reads too (`packages/shared/turnstile.json`). JSON rather
 * than a TypeScript export because this process cannot `require`
 * `@taktic/shared` itself — see common/service-request-limits.ts.
 */

/** The single-purpose request header the token travels in. */
export const TURNSTILE_TOKEN_HEADER = turnstile.headerName;

/**
 * One name per protected operation. The widget is rendered with the name of
 * the operation it is about to prove, Cloudflare echoes it back, and the
 * verifier refuses a token whose echo names any other operation — so a token
 * minted for the cheap identity pre-check cannot open a request.
 */
export const TURNSTILE_ACTIONS = turnstile.actions;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

/** What the deterministic test verifier accepts — never a real token's shape. */
export const TURNSTILE_TEST_TOKEN_PREFIX = turnstile.testTokenPrefix;
export const TURNSTILE_TEST_UNAVAILABLE_ACTION = turnstile.testUnavailableAction;

/**
 * Longer than any token Cloudflare issues (their stated ceiling is 2048
 * characters). Anything past it is not a token and is refused before it can
 * cost a network call.
 */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** How long a token stays claimed — Turnstile's own token validity window. */
export const TURNSTILE_REPLAY_TTL_MS = 5 * 60 * 1000;

import turnstile from '../../../packages/shared/turnstile.json';

/**
 * The web's share of the Turnstile contract — which is deliberately small.
 *
 * The browser produces a token; this application carries it to the API in
 * one header and makes no decision on it. "The widget succeeded" is not a
 * security fact anywhere in this file, and the API's own verifier is the
 * only place a token is ever judged. What is decided here is only *how* the
 * widget is rendered, from two server-side variables read at request time:
 *
 *   TURNSTILE_MODE      cloudflare | test | off — unset follows APP_ENVIRONMENT, below
 *   TURNSTILE_SITE_KEY  the widget's public site key — public by design, and
 *                       kept apart from TURNSTILE_SECRET_KEY, which is the
 *                       API's and is never read by this application
 *
 * Read at request time rather than as a NEXT_PUBLIC_ constant on purpose:
 * `next build` folds those into the bundle, and the browser suite builds
 * once and starts several stacks with different environments.
 *
 * An unset TURNSTILE_MODE follows the environment the stack declares, the
 * same way the API's does: `test` on APP_ENVIRONMENT=local — so the local
 * docker compose, which passes that and nothing else, renders the test
 * adapter and never loads a byte from Cloudflare — and `cloudflare`
 * everywhere else, where the site key is then required. Without it the
 * config is `unconfigured`, which is closed: the slot says the check cannot
 * run, the send and submit controls are disabled, and a call that got
 * through anyway would be refused by the API. `test` and `off` asked for
 * explicitly are accepted only on a local stack; anywhere else they read as
 * unconfigured too. NODE_ENV takes no part: under `next start` it is always
 * "production", local stack or not.
 */

export const TURNSTILE_TOKEN_HEADER = turnstile.headerName;
export const TURNSTILE_ACTIONS = turnstile.actions;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

const TEST_TOKEN_PREFIX = turnstile.testTokenPrefix;
const TEST_UNAVAILABLE_ACTION = turnstile.testUnavailableAction;
/** An action the API's test verifier never expects, so the token is refused. */
const TEST_INVALID_ACTION = '__invalid__';

export type TurnstileWebConfig =
  | { mode: 'cloudflare'; siteKey: string }
  | { mode: 'test' }
  | { mode: 'off' }
  | { mode: 'unconfigured' };

export function readTurnstileWebConfig(env: NodeJS.ProcessEnv = process.env): TurnstileWebConfig {
  const local = env.APP_ENVIRONMENT?.trim() === 'local';
  const mode = env.TURNSTILE_MODE?.trim() || (local ? 'test' : 'cloudflare');

  if (mode === 'cloudflare') {
    const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? '';
    return siteKey ? { mode, siteKey } : { mode: 'unconfigured' };
  }

  if (mode === 'test' || mode === 'off') {
    return local ? { mode } : { mode: 'unconfigured' };
  }

  return { mode: 'unconfigured' };
}

/** The one header the token travels in — or no header, so the API answers TURNSTILE_REQUIRED. */
export function turnstileHeaders(token: string | null | undefined): Record<string, string> {
  const value = token?.trim();
  return value ? { [TURNSTILE_TOKEN_HEADER]: value } : {};
}

/**
 * The client-side refusal: the widget could not produce a token at all (a
 * script that did not load, a challenge that errored or timed out). Worded
 * for the customer like the API's own three codes, and never with a detail.
 */
export const TURNSTILE_CHALLENGE_FAILED = 'TURNSTILE_CHALLENGE_FAILED';

const REFUSAL_CODES = new Set([
  'TURNSTILE_REQUIRED',
  'TURNSTILE_FAILED',
  'TURNSTILE_UNAVAILABLE',
  TURNSTILE_CHALLENGE_FAILED,
]);

export function isTurnstileRefusalCode(code: string): boolean {
  return REFUSAL_CODES.has(code);
}

/**
 * What a browser test may ask the test-mode widget to do, set on
 * `window.__TAKTIC_TURNSTILE_TEST__` before the page runs. Read only in
 * `test` mode, which only a declared local stack can be in.
 */
export type TurnstileTestOverride = { outcome: 'invalid' | 'unavailable' | 'error' };

/**
 * The token the test-mode widget hands out. Deterministic in shape, unique
 * per call — the API's replay cache is real in test mode too, so two
 * submissions need two tokens exactly as they would with Cloudflare.
 */
export function resolveTestTurnstileToken(action: TurnstileAction, override: TurnstileTestOverride | undefined): string {
  if (override?.outcome === 'error') {
    throw new Error(TURNSTILE_CHALLENGE_FAILED);
  }
  const name =
    override?.outcome === 'invalid'
      ? TEST_INVALID_ACTION
      : override?.outcome === 'unavailable'
        ? TEST_UNAVAILABLE_ACTION
        : action;
  return `${TEST_TOKEN_PREFIX}${name}:${nonce()}`;
}

function nonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

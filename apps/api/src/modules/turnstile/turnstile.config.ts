import { parseAppEnvironment } from '../../common/app-environment';

/**
 * How this process verifies a Cloudflare Turnstile token — decided once, at
 * boot, from the process's own environment and nothing a request could say.
 *
 * ## The three modes
 *
 *   cloudflare  the real thing: every protected request carries a token that
 *               is sent to Cloudflare's siteverify with this deployment's
 *               secret, and the answer is checked for success, hostname and
 *               action. This is what an unset TURNSTILE_MODE means, so a
 *               deployment that forgot to configure anything gets the strict
 *               mode — and then fails at boot because the secret is missing,
 *               rather than quietly running unprotected.
 *   test        a deterministic stand-in: tokens of the form
 *               `turnstile-test:<action>:<nonce>` are accepted when the
 *               action matches, nothing else is, and no network is involved.
 *               For the browser suite, which has to prove the token reaches
 *               the API without ever reaching Cloudflare.
 *   off         the guard lets everything through. For the integration suite,
 *               whose hundred-odd specs are about other things.
 *
 * `test` and `off` are bypasses, and a bypass is accepted only where a test
 * can be running: under NODE_ENV=test, or on a stack that declares itself
 * `local` in APP_ENVIRONMENT and is not started as production. Staging is
 * deliberately not on that list — staging is where the real widget, the real
 * hostname and the real secret are proved before production, so a staging
 * stack without Cloudflare would be proving nothing. An undeclared environment
 * is unknown, and unknown is closed (see app-environment.ts).
 *
 * ## What never leaves this file
 *
 * The secret is read here and handed to the verifier. No message names its
 * value; every refusal names the *variable* that is wrong.
 */

export const TURNSTILE_VARS = {
  mode: 'TURNSTILE_MODE',
  secretKey: 'TURNSTILE_SECRET_KEY',
  expectedHostnames: 'TURNSTILE_EXPECTED_HOSTNAMES',
  siteverifyTimeoutMs: 'TURNSTILE_SITEVERIFY_TIMEOUT_MS',
} as const;

const VARS = TURNSTILE_VARS;

export const TURNSTILE_MODES = ['cloudflare', 'test', 'off'] as const;
export type TurnstileMode = (typeof TURNSTILE_MODES)[number];

export const DEFAULT_SITEVERIFY_TIMEOUT_MS = 5000;

export type TurnstileConfig =
  | {
      mode: 'cloudflare';
      secretKey: string;
      /** Lower-cased; a token solved on any other hostname is refused. */
      expectedHostnames: ReadonlySet<string>;
      siteverifyTimeoutMs: number;
    }
  | { mode: 'test' }
  | { mode: 'off' };

/**
 * Whether a bypass mode may run in this process. Nothing about a request takes
 * part; `env` is a parameter only so the contract can be tested without
 * mutating the suite's own environment.
 */
export function isTurnstileBypassPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') {
    return true;
  }
  if (env.NODE_ENV === 'production') {
    return false;
  }
  return readAppEnvironmentFrom(env) === 'local';
}

function readAppEnvironmentFrom(env: NodeJS.ProcessEnv) {
  return parseAppEnvironment(env.APP_ENVIRONMENT);
}

function readMode(env: NodeJS.ProcessEnv): TurnstileMode {
  const raw = env[VARS.mode]?.trim();
  if (!raw) {
    return 'cloudflare';
  }
  if (!(TURNSTILE_MODES as readonly string[]).includes(raw)) {
    throw new Error(`${VARS.mode} must be one of ${TURNSTILE_MODES.join(', ')} (received "${raw}")`);
  }
  return raw as TurnstileMode;
}

function readHostnames(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env[VARS.expectedHostnames]?.trim() ?? '';
  const hostnames = new Set<string>();
  for (const entry of raw.split(',')) {
    const hostname = entry.trim().toLowerCase();
    if (hostname) {
      hostnames.add(hostname);
    }
  }
  return hostnames;
}

function readTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env[VARS.siteverifyTimeoutMs]?.trim();
  if (!raw) {
    return DEFAULT_SITEVERIFY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${VARS.siteverifyTimeoutMs} must be a positive whole number of milliseconds.`);
  }
  return parsed;
}

/**
 * The whole contract, evaluated once. Throws — with the offending variable's
 * name — rather than returning a lenient default for anything that is wrong.
 */
export function resolveTurnstileConfig(env: NodeJS.ProcessEnv = process.env): TurnstileConfig {
  const mode = readMode(env);

  if (mode === 'cloudflare') {
    const secretKey = env[VARS.secretKey]?.trim() ?? '';
    if (!secretKey) {
      throw new Error(
        `${VARS.secretKey} is required: ${VARS.mode} is "cloudflare" (the default), and every ` +
          `protected request is verified with it. Set the secret from the Cloudflare dashboard — ` +
          `or, on a local stack only, ${VARS.mode}=test with APP_ENVIRONMENT=local.`,
      );
    }
    const expectedHostnames = readHostnames(env);
    if (expectedHostnames.size === 0) {
      throw new Error(
        `${VARS.expectedHostnames} is required: a comma-separated list of the hostnames the widget ` +
          `is served on. A token solved anywhere else is refused.`,
      );
    }
    return { mode, secretKey, expectedHostnames, siteverifyTimeoutMs: readTimeout(env) };
  }

  const environment = readAppEnvironmentFrom(env);
  if (!isTurnstileBypassPermitted(env)) {
    throw new Error(
      `${VARS.mode}=${mode} is refused here: a Turnstile bypass runs only under NODE_ENV=test or ` +
        `when APP_ENVIRONMENT is "local" and NODE_ENV is not "production" ` +
        `(APP_ENVIRONMENT is ${environment ? `"${environment}"` : 'not set'}, ` +
        `NODE_ENV is "${env.NODE_ENV ?? ''}"). Remove the variable from this deployment.`,
    );
  }

  if (env[VARS.secretKey]?.trim()) {
    throw new Error(
      `${VARS.secretKey} is set while ${VARS.mode}=${mode}: a deployment that holds a secret is ` +
        `meant to verify with it. Drop one of the two.`,
    );
  }

  return { mode };
}

/**
 * Called once at boot, before anything listens, for the same reason every
 * other configuration assert in main.ts is: the person who set this up is at
 * the keyboard now, and a marketplace whose request forms all answer 503 is
 * not something to learn from a customer.
 */
export function assertTurnstileConfig(): void {
  resolveTurnstileConfig();
}

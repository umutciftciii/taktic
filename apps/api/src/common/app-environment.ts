/**
 * Which deployment this process is: the server's own statement, read from the
 * server's own environment.
 *
 * `NODE_ENV` cannot carry this. The staging stack runs with
 * `NODE_ENV=development` (see cookie-security.ts for why that was the wrong
 * question there too), and `NODE_ENV=production` on a laptop is a common way
 * to test a build. So a deployment says which one it is in a variable that
 * means only that — and a process that says nothing is treated as the most
 * restrictive answer by every reader, because the readers are all gates on
 * behaviour that must not exist in production.
 *
 * **Nothing here reads a request.** `Origin`, `Host`, `Referer`, the client
 * address and a query string are all supplied by whoever is talking, and an
 * environment that could be chosen by the caller is not an environment. This
 * function takes no arguments for that reason.
 *
 * Read on every call rather than cached at import time, so a test that sets
 * the variable sees the environment it set.
 */
export const APP_ENVIRONMENTS = ['local', 'staging', 'production'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export function isAppEnvironment(value: string): value is AppEnvironment {
  return (APP_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * The declared environment, or null when the deployment has not said.
 *
 * A value that is set but not one of the three is a configuration error and
 * is refused loudly: a typo in the environment name must not quietly read as
 * "not production".
 */
export function readAppEnvironment(): AppEnvironment | null {
  return parseAppEnvironment(process.env.APP_ENVIRONMENT);
}

/**
 * The same rule applied to a supplied value, for a reader that was handed an
 * environment rather than reading the process's own (turnstile.config.ts).
 */
export function parseAppEnvironment(value: string | undefined): AppEnvironment | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }

  if (!isAppEnvironment(raw)) {
    throw new Error(
      `APP_ENVIRONMENT must be one of ${APP_ENVIRONMENTS.join(', ')} (received "${raw}")`,
    );
  }

  return raw;
}

/**
 * Whether this process may run test-only behaviour.
 *
 * Only an explicit `local` or `staging` qualifies, and even then not under
 * `NODE_ENV=production`: a build started as production is production whatever
 * it calls itself. An unset environment is not "probably local" — it is
 * unknown, and unknown is closed.
 */
export function isTestBehaviourPermitted(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  const environment = readAppEnvironment();
  return environment === 'local' || environment === 'staging';
}

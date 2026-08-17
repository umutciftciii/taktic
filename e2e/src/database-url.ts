/**
 * The single gate between this suite and a database it must never touch.
 *
 * The browser suite drives the real API, which truncates nothing on its own —
 * so an E2E run pointed at the development database would quietly mix test
 * fixtures into hand-made data, and one pointed at a production URL would be a
 * disaster. Every entry point (the Playwright config, the prepare script, the
 * teardown) resolves its URL through here, and the assertion below is what
 * makes "wrong database" a startup failure instead of a discovery.
 *
 * The rule is a name suffix rather than a host allowlist on purpose: a host
 * check invites "well, staging is fine", while `_e2e` is a mark somebody has to
 * put on a database deliberately.
 */

const REQUIRED_SUFFIX = '_e2e';

/**
 * E2E_DATABASE_URL wins; otherwise the URL is derived from DATABASE_URL by
 * appending the suffix. Deriving rather than reusing is the point: the
 * development URL can never be handed back unchanged.
 */
export function resolveE2eDatabaseUrl(): string {
  const explicit = process.env.E2E_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const base = process.env.DATABASE_URL?.trim();
  if (!base) {
    throw new Error(
      'Neither E2E_DATABASE_URL nor DATABASE_URL is set; refusing to guess an end-to-end database.',
    );
  }

  const url = new URL(base);
  const databaseName = url.pathname.replace(/^\//, '');
  if (!databaseName) {
    throw new Error(`DATABASE_URL has no database name: ${redact(base)}`);
  }

  if (databaseName.endsWith(REQUIRED_SUFFIX)) {
    return base;
  }

  // Derived from the development name, never equal to it. `taktic` becomes
  // `taktic_e2e`, and `taktic_test` (the Vitest database) becomes
  // `taktic_test_e2e` — so the two suites can never share a database either.
  url.pathname = `/${databaseName}${REQUIRED_SUFFIX}`;
  return url.toString();
}

export function assertIsE2eDatabase(databaseUrl: string): void {
  let name: string;

  try {
    name = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('The end-to-end database URL is not a valid URL.');
  }

  if (!name.endsWith(REQUIRED_SUFFIX)) {
    throw new Error(
      `Refusing to run the end-to-end suite against "${name}": the database name must end with ${REQUIRED_SUFFIX}. ` +
        'Set E2E_DATABASE_URL to a dedicated database, or leave it unset to derive one from DATABASE_URL.',
    );
  }
}

/** Resolves and validates in one step. Every entry point calls this. */
export function requireE2eDatabaseUrl(): string {
  const url = resolveE2eDatabaseUrl();
  assertIsE2eDatabase(url);
  return url;
}

export function describeDatabase(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function redact(value: string): string {
  try {
    const url = new URL(value);
    url.password = '***';
    return url.toString();
  } catch {
    return '(unparseable url)';
  }
}

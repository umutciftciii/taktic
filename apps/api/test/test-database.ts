/**
 * Every integration test runs against a dedicated database that exists only for
 * the test suite.
 *
 * The URL is derived from TEST_DATABASE_URL, or from DATABASE_URL with the
 * database name swapped for `<name>_test`. Deriving it (rather than reusing
 * DATABASE_URL) is what keeps the suite from ever truncating the development
 * database — and resolveTestDatabaseUrl refuses to hand back a URL that still
 * points at the development database.
 */
export function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const base = process.env.DATABASE_URL?.trim();
  if (!base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set; refusing to guess a test database.',
    );
  }

  const url = new URL(base);
  const databaseName = url.pathname.replace(/^\//, '');
  if (!databaseName) {
    throw new Error(`DATABASE_URL has no database name: ${redact(base)}`);
  }

  if (databaseName.endsWith('_test')) {
    return base;
  }

  url.pathname = `/${databaseName}_test`;
  return url.toString();
}

export function assertIsTestDatabase(databaseUrl: string): void {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the database name must end with _test.`,
    );
  }
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

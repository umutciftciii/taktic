import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Every integration test runs against a database that exists only for the test
 * suite — and only for *this checkout* of it.
 *
 * The per-checkout part is not a nicety. The suite truncates twenty-two tables
 * before every spec, so two runs sharing one database delete each other's
 * fixtures mid-test: the second run's TRUNCATE lands between the first run's
 * `beforeEach` and its assertion, and the damage surfaces as an unrelated
 * status code — a 401 from a session row that no longer exists, a 404 from a
 * fixture that does not, a 400 from a token that looks consumed. Measured on
 * this suite, a three-second overlap between two runs failed exactly one test
 * out of 387; a full overlap failed a hundred and fifty. Naming the database
 * after the checkout removes the shared resource rather than trying to schedule
 * access to it, so several worktrees and a CI matrix can test against one
 * PostgreSQL server at the same time.
 *
 * The name is derived, never configured by hand:
 *
 *     <base>_<slug>_test        e.g. taktic_3f2a9c1b7d_test
 *
 * `base` comes from DATABASE_URL and `slug` is a hash of the checkout's
 * absolute path. The path itself never reaches the name or a log line: a hash
 * is enough to tell two checkouts apart, and a developer's directory layout is
 * nobody else's business.
 *
 * `_test` stays where it has always been, at the end, because that is what
 * {@link assertIsTestDatabase} keys on — the guard that makes running against
 * the development database impossible is unchanged in meaning.
 */

/** Hex characters of the checkout hash kept in the name. */
const SLUG_LENGTH = 10;

/** PostgreSQL truncates identifiers past NAMEDATALEN-1 bytes. */
const MAX_IDENTIFIER_BYTES = 63;

const TEST_SUFFIX = '_test';

/**
 * The shape every database this suite will talk to must have.
 *
 * Anchored, lowercase, and ending in `_test`: a development name (`taktic`) or
 * a production one cannot match, whatever else goes wrong upstream.
 */
const TEST_DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/;

/** What TEST_DATABASE_SLUG may contain, so an override cannot bend the identifier out of shape. */
const VALID_SLUG = /^[a-z0-9_]{1,24}$/;

/**
 * Hosts on which this suite may create a database by itself.
 *
 * Loopback only. A developer's machine and this project's CI both reach
 * PostgreSQL over loopback; anywhere else — a shared staging server, a managed
 * instance — CREATE DATABASE should be a person's decision, not a test run's.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The checkout this file belongs to.
 *
 * Derived from the module's own location rather than `process.cwd()`, so the
 * Vitest main process, every forked worker and any script that imports this
 * agree on one answer no matter where they were started from.
 */
export const checkoutRoot = resolve(__dirname, '../../..');

/**
 * A short, stable identifier for a checkout.
 *
 * SHA-256 rather than something readable: two worktrees of one repository have
 * nearly identical paths, and any truncation of the path itself would collide
 * exactly where it matters.
 */
export function checkoutSlug(checkoutPath: string = checkoutRoot): string {
  const override = process.env.TEST_DATABASE_SLUG?.trim();
  if (override !== undefined && override !== '') {
    if (!VALID_SLUG.test(override)) {
      throw new Error(
        'TEST_DATABASE_SLUG must be 1-24 characters of a-z, 0-9 or underscore. ' +
          'It becomes part of a PostgreSQL identifier, so anything else is refused rather than escaped.',
      );
    }
    return override;
  }

  return createHash('sha256').update(checkoutPath).digest('hex').slice(0, SLUG_LENGTH);
}

/**
 * Composes the per-checkout name inside PostgreSQL's identifier limit, trimming
 * the base rather than the parts that carry meaning: the slug is what makes the
 * name unique and `_test` is what makes it safe, so an over-long database name
 * loses characters from its own front instead.
 */
export function testDatabaseName(baseName: string, slug: string = checkoutSlug()): string {
  const base = baseName.endsWith(TEST_SUFFIX)
    ? baseName.slice(0, -TEST_SUFFIX.length)
    : baseName;
  if (!base) {
    throw new Error(`Cannot derive a test database name from "${baseName}".`);
  }

  const tail = `_${slug}${TEST_SUFFIX}`;
  const room = MAX_IDENTIFIER_BYTES - Buffer.byteLength(tail, 'utf8');
  if (room < 1) {
    throw new Error(
      `TEST_DATABASE_SLUG "${slug}" leaves no room for a database name within ` +
        `PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit.`,
    );
  }

  return `${truncateToBytes(base, room)}${tail}`;
}

/**
 * TEST_DATABASE_URL wins; otherwise the URL is derived from DATABASE_URL with
 * the database name replaced by this checkout's own.
 *
 * Deriving rather than reusing is the point: the development URL can never be
 * handed back unchanged, and two checkouts can never be handed the same one. An
 * explicit TEST_DATABASE_URL is returned as given — it is a deliberate choice —
 * but it still has to clear {@link assertIsTestDatabase}, so choosing it
 * deliberately is not the same as choosing it unsafely.
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

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${redact(base)}`);
  }

  const databaseName = url.pathname.replace(/^\//, '');
  if (!databaseName) {
    throw new Error(`DATABASE_URL has no database name: ${redact(base)}`);
  }

  url.pathname = `/${testDatabaseName(databaseName)}`;
  return url.toString();
}

/**
 * The gate between this suite and a database it must never touch.
 *
 * Every entry point — the Vitest global setup, the per-worker setup file, the
 * seed smoke test — calls this, and it is what makes "wrong database" a startup
 * failure instead of a discovery.
 */
export function assertIsTestDatabase(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('The test database URL is not a valid URL.');
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(
      `Refusing to run tests over "${url.protocol}": the suite speaks to PostgreSQL only.`,
    );
  }

  if (!url.hostname) {
    throw new Error('The test database URL names no host.');
  }

  const name = url.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error('The test database URL names no database.');
  }

  const nameBytes = Buffer.byteLength(name, 'utf8');
  if (nameBytes > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Refusing to run tests against a ${nameBytes}-byte database name: PostgreSQL truncates past ` +
        `${MAX_IDENTIFIER_BYTES} bytes, so two checkouts could silently land on one database.`,
    );
  }

  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to run tests against "${name}": the name must end with ${TEST_SUFFIX} and hold ` +
        'only lowercase letters, digits and underscores. Set TEST_DATABASE_URL to a dedicated ' +
        'database, or leave it unset to derive one from DATABASE_URL.',
    );
  }
}

/**
 * Whether this suite may create the database itself rather than asking a person
 * to. See {@link LOOPBACK_HOSTS}.
 */
export function isAutoProvisionable(databaseUrl: string): boolean {
  const hostname = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** The database name alone, for a log line or a CREATE DATABASE statement. */
export function databaseNameOf(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function truncateToBytes(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
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

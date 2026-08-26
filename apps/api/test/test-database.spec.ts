import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTestDatabaseExists,
  maintenanceUrlFor,
  type ProvisionDeps,
} from './provision-test-database';
import {
  assertIsTestDatabase,
  checkoutSlug,
  databaseNameOf,
  isAutoProvisionable,
  resolveTestDatabaseUrl,
  testDatabaseName,
} from './test-database';

/**
 * The rules that keep two concurrent runs off one database, and every run off
 * the development one.
 *
 * Pure: no database, no application. That is the point — these are the checks
 * that have to hold *before* anything connects, and a test that needed a
 * connection could not assert the interesting half of them.
 */

const HOST = 'postgresql://user:secret@localhost:5432';
const REMOTE = 'postgresql://user:secret@db.internal.example';

/**
 * The suite's own environment leaks into these functions by design, so each
 * case states the world it wants and hands the previous one back.
 */
const TOUCHED = ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_DATABASE_SLUG'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('per-checkout database naming', () => {
  it('gives one checkout the same name every time', () => {
    const path = '/Users/dev/projects/taktic';

    expect(checkoutSlug(path)).toBe(checkoutSlug(path));
    expect(testDatabaseName('taktic', checkoutSlug(path))).toBe(
      testDatabaseName('taktic', checkoutSlug(path)),
    );
  });

  it('gives sibling worktrees different names', () => {
    // The shape that caused the flake: two checkouts of one repository, whose
    // paths differ only in the last segment.
    const names = [
      '/Users/dev/projects/taktic',
      '/Users/dev/projects/taktic/.claude/worktrees/feature-a',
      '/Users/dev/projects/taktic/.claude/worktrees/feature-b',
      '/home/runner/work/taktic/taktic',
    ].map((path) => testDatabaseName('taktic', checkoutSlug(path)));

    expect(new Set(names).size).toBe(names.length);
  });

  it('stays inside PostgreSQL’s identifier limit and keeps the _test suffix', () => {
    const cases = [
      testDatabaseName('taktic', checkoutSlug('/Users/dev/projects/taktic')),
      // A base long enough that something has to give. The slug and the suffix
      // are what carry the meaning, so the base is what loses characters.
      testDatabaseName('a'.repeat(200), checkoutSlug('/Users/dev/projects/taktic')),
      testDatabaseName('x', 'z'.repeat(24)),
    ];

    for (const name of cases) {
      expect(name.endsWith('_test'), `${name} must end with _test`).toBe(true);
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
      // Still a name the guard will admit, not merely a short string.
      expect(() =>
        assertIsTestDatabase(`postgresql://user:secret@localhost:5432/${name}`),
      ).not.toThrow();
    }
  });

  it('does not stack a suffix onto a base that already carries one', () => {
    const name = testDatabaseName('taktic_test', 'abc123');

    expect(name).toBe('taktic_abc123_test');
  });
});

describe('TEST_DATABASE_SLUG', () => {
  it('overrides the derived slug', () => {
    process.env.TEST_DATABASE_SLUG = 'ci_shard_3';

    expect(checkoutSlug('/any/path')).toBe('ci_shard_3');
    expect(testDatabaseName('taktic')).toBe('taktic_ci_shard_3_test');
  });

  it('refuses a value that would bend the identifier out of shape', () => {
    for (const bad of ['UPPER', 'has space', 'quote"drop', 'semi;colon', 'dash-ed', 'x'.repeat(25)]) {
      process.env.TEST_DATABASE_SLUG = bad;
      expect(() => checkoutSlug('/any/path'), `${bad} must be refused`).toThrow(
        /TEST_DATABASE_SLUG/,
      );
    }
  });

  it('ignores an empty value rather than producing a nameless slug', () => {
    process.env.TEST_DATABASE_SLUG = '   ';

    expect(checkoutSlug('/any/path')).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe('resolveTestDatabaseUrl', () => {
  it('derives a per-checkout database from DATABASE_URL', () => {
    process.env.DATABASE_URL = `${HOST}/taktic?schema=public`;
    process.env.TEST_DATABASE_SLUG = 'abc123';

    const resolved = resolveTestDatabaseUrl();

    expect(databaseNameOf(resolved)).toBe('taktic_abc123_test');
    // Everything else about the operator's URL survives.
    expect(new URL(resolved).searchParams.get('schema')).toBe('public');
    expect(new URL(resolved).port).toBe('5432');
  });

  it('never hands back the development database', () => {
    process.env.DATABASE_URL = `${HOST}/taktic`;

    const resolved = resolveTestDatabaseUrl();

    expect(databaseNameOf(resolved)).not.toBe('taktic');
    expect(() => assertIsTestDatabase(resolved)).not.toThrow();
  });

  it('uses TEST_DATABASE_URL exactly as given, and still checks it', () => {
    process.env.DATABASE_URL = `${HOST}/taktic`;
    process.env.TEST_DATABASE_URL = `${HOST}/somebody_elses_test`;

    const resolved = resolveTestDatabaseUrl();

    expect(resolved).toBe(`${HOST}/somebody_elses_test`);
    expect(() => assertIsTestDatabase(resolved)).not.toThrow();

    // Deliberate is not the same as safe: an explicit URL clears no guard.
    process.env.TEST_DATABASE_URL = `${HOST}/taktic`;
    expect(() => assertIsTestDatabase(resolveTestDatabaseUrl())).toThrow(/must end with _test/);
  });

  it('refuses to guess when neither variable is set', () => {
    expect(() => resolveTestDatabaseUrl()).toThrow(/refusing to guess/i);
  });
});

describe('assertIsTestDatabase', () => {
  it('admits a name in the test family', () => {
    expect(() => assertIsTestDatabase(`${HOST}/taktic_3f2a9c1b7d_test`)).not.toThrow();
    expect(() => assertIsTestDatabase(`${REMOTE}/taktic_ci_test`)).not.toThrow();
  });

  it('refuses development and production names', () => {
    for (const name of ['taktic', 'taktic_prod', 'production', 'taktic_test_backup', 'postgres']) {
      expect(() => assertIsTestDatabase(`${HOST}/${name}`), `${name} must be refused`).toThrow(
        /must end with _test/,
      );
    }
  });

  it('refuses a name that only looks like the test family', () => {
    for (const name of ['Taktic_TEST', '9taktic_test', 'taktic-x_test', 'taktic_test;drop']) {
      expect(() => assertIsTestDatabase(`${HOST}/${name}`), `${name} must be refused`).toThrow();
    }
  });

  it('refuses empty, oversized and malformed targets', () => {
    expect(() => assertIsTestDatabase(`${HOST}/`)).toThrow(/names no database/);
    expect(() => assertIsTestDatabase('not a url')).toThrow(/not a valid URL/);
    expect(() => assertIsTestDatabase('mysql://user@localhost:3306/taktic_test')).toThrow(
      /PostgreSQL only/,
    );
    // Past NAMEDATALEN-1 PostgreSQL truncates silently, which would put two
    // checkouts back on one database — the exact failure this design removes.
    expect(() => assertIsTestDatabase(`${HOST}/${'a'.repeat(59)}_test`)).toThrow(
      /PostgreSQL truncates past 63 bytes/,
    );
    // One byte under the limit is fine, so the check is a limit and not a mood.
    expect(() => assertIsTestDatabase(`${HOST}/${'a'.repeat(58)}_test`)).not.toThrow();
  });
});

describe('provisioning', () => {
  const target = `${HOST}/taktic_abc123_test`;

  function deps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
    return {
      canConnect: vi.fn(async () => false),
      createDatabase: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('does nothing when the database is already there', async () => {
    const d = deps({ canConnect: vi.fn(async () => true) });

    await expect(ensureTestDatabaseExists(target, d)).resolves.toBe('existing');
    expect(d.createDatabase).not.toHaveBeenCalled();
  });

  it('creates the database on loopback, through the maintenance database', async () => {
    const d = deps();

    await expect(ensureTestDatabaseExists(target, d)).resolves.toBe('created');

    expect(d.createDatabase).toHaveBeenCalledTimes(1);
    const [maintenanceUrl, name] = vi.mocked(d.createDatabase).mock.calls[0]!;

    expect(name).toBe('taktic_abc123_test');
    // The statement is issued against PostgreSQL's own maintenance database.
    // Nothing is written to the application database — not a table, not a row.
    expect(databaseNameOf(maintenanceUrl)).toBe('postgres');
    expect(databaseNameOf(maintenanceUrl)).not.toBe('taktic');
  });

  it('refuses to create anything on a host it did not set up', async () => {
    const d = deps();

    await expect(
      ensureTestDatabaseExists(`${REMOTE}/taktic_abc123_test`, d),
    ).rejects.toThrow(/only creates databases on loopback/);
    expect(d.createDatabase).not.toHaveBeenCalled();
  });

  it('refuses to create a database outside the test family', async () => {
    const d = deps();

    await expect(ensureTestDatabaseExists(`${HOST}/taktic`, d)).rejects.toThrow(
      /must end with _test/,
    );
    expect(d.canConnect).not.toHaveBeenCalled();
    expect(d.createDatabase).not.toHaveBeenCalled();
  });

  it('knows which hosts it may provision on', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'api.localhost']) {
      expect(isAutoProvisionable(`postgresql://u:p@${host}:5432/x_test`), host).toBe(true);
    }
    for (const host of ['db.internal.example', '10.0.0.5', 'rds.amazonaws.com']) {
      expect(isAutoProvisionable(`postgresql://u:p@${host}:5432/x_test`), host).toBe(false);
    }
  });

  it('keeps the operator’s connection details when addressing the maintenance database', () => {
    const maintenance = maintenanceUrlFor(`${HOST}/taktic_abc123_test?schema=public`);
    const url = new URL(maintenance);

    expect(url.pathname).toBe('/postgres');
    expect(url.host).toBe('localhost:5432');
    expect(url.username).toBe('user');
    expect(url.searchParams.get('schema')).toBe('public');
  });
});

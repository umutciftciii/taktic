import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureTestDatabaseExists } from './provision-test-database';
import {
  assertIsTestDatabase,
  checkoutSlug,
  databaseNameOf,
  resolveTestDatabaseUrl,
} from './test-database';

const repoRoot = resolve(__dirname, '../../..');

/**
 * Prepares this checkout's test database once per run: create it if this
 * checkout has never run before, then apply the committed migration chain.
 *
 * Creating it is a separate step because `prisma migrate deploy` applies
 * migrations to a database and does not create one. That gap used to be
 * invisible — every checkout shared a `taktic_test` somebody had created by
 * hand once — and per-checkout naming is what brings it into the open.
 *
 * Nothing here touches the development database: assertIsTestDatabase admits
 * only names in the `_test` family, and the creation step connects to
 * PostgreSQL's maintenance database rather than to the application's.
 */
export default async function setup() {
  // Read before the assignment below overwrites it, so the log line can say
  // whether this run was told which database to use or worked it out.
  const wasExplicit = Boolean(process.env.TEST_DATABASE_URL?.trim());

  const databaseUrl = resolveTestDatabaseUrl();
  assertIsTestDatabase(databaseUrl);

  const outcome = await ensureTestDatabaseExists(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.TEST_DATABASE_URL = databaseUrl;

  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      // Piped rather than inherited: Prisma prints the host it connected to on
      // every run, and this suite has no reason to put that on a shared CI log
      // when nothing went wrong. On failure the output is exactly what the
      // reader needs, so it is passed straight through.
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    process.stderr.write(failure.stderr?.toString() ?? '');
    process.stdout.write(failure.stdout?.toString() ?? '');
    throw error;
  }

  // One line, and deliberately only this much: the database name and an
  // anonymous checkout identifier are what a reader needs to tell two
  // concurrent runs apart. The checkout path, the host and the credentials are
  // not, and a CI log is a place they should never appear.
  const origin = wasExplicit ? 'from TEST_DATABASE_URL' : `checkout ${checkoutSlug()}`;
  console.log(`[api-test] database "${databaseNameOf(databaseUrl)}" (${origin}, ${outcome})`);
}

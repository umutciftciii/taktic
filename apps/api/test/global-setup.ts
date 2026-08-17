import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertIsTestDatabase, resolveTestDatabaseUrl } from './test-database';

const repoRoot = resolve(__dirname, '../../..');

/**
 * Prepares the isolated test database once per run: `prisma migrate deploy`
 * creates it if it does not exist and applies the committed migration chain.
 *
 * Nothing here touches the development database — assertIsTestDatabase refuses
 * any URL whose database name does not end with `_test`.
 */
export default function setup() {
  const databaseUrl = resolveTestDatabaseUrl();
  assertIsTestDatabase(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.TEST_DATABASE_URL = databaseUrl;

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

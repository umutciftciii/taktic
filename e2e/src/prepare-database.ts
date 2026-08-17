import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { describeDatabase, requireE2eDatabaseUrl } from './database-url';
import { disconnectE2ePrisma, e2ePrisma, truncateE2eDatabase } from './database';
import { outboxDir, repoRoot } from './runtime';

/**
 * Runs before Playwright starts anything.
 *
 * Doing this here rather than in a Playwright globalSetup is deliberate:
 * Playwright launches the webServer processes around the same time as global
 * setup, and migrating a database that six application processes are already
 * connected to is a race waiting to happen. Chaining this script in front of
 * `playwright test` gives a strict order — guard, migrate, truncate, then boot.
 */
async function main() {
  const databaseUrl = requireE2eDatabaseUrl();
  const name = describeDatabase(databaseUrl);

  console.log(`[e2e] preparing database "${name}"`);

  // `migrate deploy` creates the database when it does not exist yet, so a
  // first run on a clean machine needs no manual CREATE DATABASE.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  const prisma = e2ePrisma();
  try {
    await truncateE2eDatabase(prisma);
  } finally {
    await disconnectE2ePrisma();
  }

  // The outbox is a transcript of one run, not a growing log: a code left over
  // from a previous run could satisfy a poll that should have failed.
  rmSync(outboxDir, { recursive: true, force: true });
  mkdirSync(outboxDir, { recursive: true });

  console.log(`[e2e] database "${name}" migrated and emptied`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

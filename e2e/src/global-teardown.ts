import { disconnectE2ePrisma, e2ePrisma, truncateE2eDatabase } from './database';

/**
 * Empties the E2E database once the run is over.
 *
 * The database itself is kept: dropping it would make every run pay for a fresh
 * `migrate deploy`, and an empty `_e2e` database is not something anybody has to
 * be protected from. Everything in it was created by this suite, so truncating
 * removes exactly the suite's own records and nothing else.
 *
 * Failures here are reported but never fail the run — a teardown problem must
 * not turn a green suite red, and the next run truncates before it starts
 * anyway.
 */
export default async function globalTeardown() {
  try {
    await truncateE2eDatabase(e2ePrisma());
  } catch (error) {
    console.warn(
      `[e2e] could not empty the end-to-end database after the run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await disconnectE2ePrisma();
  }
}

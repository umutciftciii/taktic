import { assertIsTestDatabase, resolveTestDatabaseUrl } from './test-database';

/**
 * Runs in every test worker before any application module is imported, so
 * PrismaClient picks up the isolated test database rather than the development
 * one it would otherwise inherit from the container environment.
 */
const databaseUrl = resolveTestDatabaseUrl();
assertIsTestDatabase(databaseUrl);

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
// No scheduled worker may start inside the suite. All three already default to
// disabled; setting them explicitly means a stray value in the developer's
// shell cannot let a cron fire mid-test and rewrite rows a case is asserting on.
// The lifecycle specs drive their jobs by calling the services directly.
process.env.REFUND_SCHEDULER_ENABLED = 'false';
process.env.REQUEST_EXPIRY_SCHEDULER_ENABLED = 'false';
process.env.REQUEST_REMINDER_SCHEDULER_ENABLED = 'false';
// A small, explicit auth budget keeps the rate-limit test fast. Each spec file
// boots its own Nest app, so the in-memory counters never leak between files.
process.env.AUTH_RATE_LIMIT_MAX ??= '5';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ??= '60';

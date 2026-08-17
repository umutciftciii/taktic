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
// The scheduled refund worker must never start inside the suite.
process.env.REFUND_SCHEDULER_ENABLED = 'false';
// A small, explicit auth budget keeps the rate-limit test fast. Each spec file
// boots its own Nest app, so the in-memory counters never leak between files.
process.env.AUTH_RATE_LIMIT_MAX ??= '5';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ??= '60';

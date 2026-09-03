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
process.env.UNVIEWED_OFFER_REFUND_ENABLED = 'false';
process.env.REQUEST_EXPIRY_SCHEDULER_ENABLED = 'false';
process.env.REQUEST_REMINDER_SCHEDULER_ENABLED = 'false';
// A small, explicit auth budget keeps the rate-limit test fast. Each spec file
// boots its own Nest app, so the in-memory counters never leak between files.
process.env.AUTH_RATE_LIMIT_MAX ??= '5';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS ??= '60';
// The suite never talks to an e-mail provider: every case either overrides
// NotificationPort with the recording double or constructs the Resend adapter
// with a stand-in transport. Pinning the switch and dropping any key the
// developer happens to have exported means a stray shell variable cannot turn a
// test run into real mail.
process.env.EMAIL_TRANSPORT = 'console';
delete process.env.EMAIL_FROM;
delete process.env.RESEND_API_KEY;
// The suite never talks to a payment provider. Pinning the switch to the mock
// adapter and dropping any Lemon Squeezy credential the developer happens to
// have exported means a stray shell variable cannot point a test run at a real
// sandbox store. The payment specs set these explicitly, and construct the
// adapter with a stand-in transport.
process.env.PAYMENT_PROVIDER = 'mock';
delete process.env.LEMON_SQUEEZY_API_KEY;
delete process.env.LEMON_SQUEEZY_STORE_ID;
delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
delete process.env.LEMON_SQUEEZY_VARIANT_MAP;
delete process.env.LEMON_SQUEEZY_API_BASE_URL;
delete process.env.LEMON_SQUEEZY_MODE;

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
// No cron may fire inside the suite.
//
// Whether a job acts is a database setting now, and the scheduler suite really
// does switch jobs on — so "the flags are false" is no longer what keeps a
// worker away from a fixture. What does is the half that stayed deployment
// configuration: every schedule is pinned to one minute a year, so no timer
// this process registers can reach a running test. The specs invoke each job's
// own cron handler directly instead, which is the seam that matters.
process.env.ENTITLEMENT_RENEWAL_CRON = '0 0 1 1 *';
process.env.UNVIEWED_OFFER_REFUND_CRON = '0 0 1 1 *';
process.env.REQUEST_EXPIRY_SCHEDULER_CRON = '0 0 1 1 *';
process.env.REQUEST_REMINDER_SCHEDULER_CRON = '0 0 1 1 *';
// The campaign evaluation worker (CMP-002 S2B2) too: the specs drive
// `runOnce` themselves, and a tick landing between "the event is PENDING" and
// "the worker grants it" would make those assertions race.
process.env.CAMPAIGN_EVALUATION_RETRY_CRON = '0 0 1 1 *';
// The flags that used to decide this are gone from the application. Dropped
// rather than pinned, so a developer's exported value cannot make the boot log
// of every spec file carry a deprecation warning.
delete process.env.ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED;
delete process.env.UNVIEWED_OFFER_REFUND_ENABLED;
delete process.env.REQUEST_EXPIRY_SCHEDULER_ENABLED;
delete process.env.REQUEST_REMINDER_SCHEDULER_ENABLED;
// CMP-006 PR-A: the purchase-terms gate starts closed in every spec, whatever
// a developer has exported. Specs that open it set and restore it themselves.
delete process.env.PURCHASE_TERMS_GATE;
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
// The phone-verification test bypass is off unless a spec turns it on, and the
// environment is undeclared unless a spec declares one: every clause of that
// contract is exercised by phone-verification-test-bypass.spec.ts, and a value
// exported in the developer's shell must not be able to satisfy one of them
// from outside the suite.
delete process.env.APP_ENVIRONMENT;
delete process.env.PHONE_VERIFICATION_TEST_BYPASS_ENABLED;
delete process.env.PHONE_VERIFICATION_TEST_BYPASS_PHONES;
delete process.env.PHONE_VERIFICATION_TEST_BYPASS_CODE;
delete process.env.PHONE_VERIFICATION_TEST_BYPASS_EXPIRES_AT;
// Turnstile is off for the suite as a whole: the hundred-odd specs that post
// to the protected routes are about other things, and `off` is accepted here
// only because NODE_ENV is "test" (turnstile.config.ts). The guard itself is
// exercised by turnstile-protection.spec.ts, which overrides the verifier
// with the real Cloudflare one over a stand-in fetch. Any Cloudflare secret
// the developer has exported is dropped so it can neither reach a real
// siteverify nor collide with the `off` mode at boot.
process.env.TURNSTILE_MODE = 'off';
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.TURNSTILE_EXPECTED_HOSTNAMES;
delete process.env.TURNSTILE_SITEVERIFY_TIMEOUT_MS;

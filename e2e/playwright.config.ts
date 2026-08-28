import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { describeDatabase, requireE2eDatabaseUrl } from './src/database-url';
import {
  E2E_LEMON_API_KEY,
  E2E_LEMON_PACKAGE_SLUG,
  E2E_LEMON_STORE_ID,
  E2E_LEMON_VARIANT_ID,
  E2E_LEMON_WEBHOOK_SECRET,
  artifactsDir,
  contactSharingRuntime,
  lemonSqueezyRuntime,
  lemonStubPort,
  lemonStubUrl,
  outboxDir,
  phoneGateRuntime,
  primaryRuntime,
  providerClaimRuntime,
  repoRoot,
  type Runtime,
} from './src/runtime';

/**
 * Resolved at module scope, which is the earliest possible moment: Playwright
 * evaluates this file before it launches a single server. An unsafe database
 * URL therefore aborts the run before any application process exists, rather
 * than after six of them have already connected.
 */
const databaseUrl = requireE2eDatabaseUrl();
const isCI = Boolean(process.env.CI);

console.log(`[e2e] database: ${describeDatabase(databaseUrl)}`);

const apiDir = resolve(repoRoot, 'apps/api');
const webDir = resolve(repoRoot, 'apps/web');
const adminDir = resolve(repoRoot, 'apps/admin');

/**
 * Environment shared by every application process in the suite.
 *
 * NODE_ENV stays "test": it keeps cookies non-secure over plain HTTP (the login
 * server action marks the session cookie `secure` in production, which a
 * headless browser on http:// would silently drop) and it is what the outbox
 * transport refuses to run without.
 */
const sharedEnv = {
  NODE_ENV: 'test',
  // The servers run in UTC, as a container does, whatever zone the developer's
  // machine is in. Without this the suite only reproduces the server/browser
  // zone split on a CI box that happens to be in UTC — and the hydration check
  // in offer-detail-hydration.spec.ts would quietly prove nothing on a laptop
  // in Istanbul.
  TZ: 'UTC',
  DATABASE_URL: databaseUrl,
  AUTH_COOKIE_NAME: 'taktic_session',
  // Both schedulers stay off: a cron firing mid-run could expire a fixture
  // while a test is asserting on it.
  REFUND_SCHEDULER_ENABLED: 'false',
  REQUEST_EXPIRY_SCHEDULER_ENABLED: 'false',
  REQUEST_REMINDER_SCHEDULER_ENABLED: 'false',
  // The credential throttle keys on the client IP, and every actor in the suite
  // is 127.0.0.1 — at the shipped budget of 10 per minute the run would only be
  // measuring how many people it signed in. The limit itself is a configurable
  // deployment value and has its own integration test (auth-rate-limit.spec.ts);
  // raising it here changes no rule these scenarios are about.
  AUTH_RATE_LIMIT_MAX: '1000',
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
};

function apiServer(runtime: Runtime) {
  return {
    // The compiled entry point, so the suite exercises the same artefact CI
    // builds. `pnpm build` is chained in front of the e2e script.
    command: 'node dist/main.js',
    cwd: apiDir,
    url: `${runtime.apiUrl}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: {
      ...sharedEnv,
      API_PORT: String(runtime.ports.api),
      REQUIRE_PHONE_VERIFICATION: String(runtime.requirePhoneVerification),
      // Off for every runtime but the contact-sharing one. The API refuses to
      // boot with the flag on and no https URL and version, so a stack that
      // asks for the feature has to supply both here.
      CONTACT_SHARING_ENABLED: String(runtime.contactSharing.enabled),
      // Off for every runtime but the claim one. The API refuses to boot with
      // the flag on in production without a delivering e-mail transport; here
      // NODE_ENV is "test", so the file outbox below is what carries the link.
      PROVIDER_CLAIM_ENABLED: String(runtime.providerClaim),
      ...(runtime.contactSharing.enabled
        ? {
            CONTACT_DISCLOSURE_URL: runtime.contactSharing.disclosureUrl,
            CONTACT_DISCLOSURE_VERSION: runtime.contactSharing.disclosureVersion,
          }
        : {}),
      // Swaps the console transports for ones that record what they sent, so
      // the phone-verification test can read the code it was supposed to
      // receive and the claim test can follow the link it was supposed to get,
      // instead of scraping a log line.
      NOTIFICATION_OUTBOX_DIR: outboxDir,
      // Stated explicitly rather than inferred from the directory above: the
      // suite must never be one stray environment variable away from handing a
      // real provider a live claim link.
      EMAIL_TRANSPORT: 'file-outbox',
      WEB_ORIGIN: runtime.webUrl,
      ADMIN_ORIGIN: runtime.adminUrl,
      API_PUBLIC_URL: runtime.apiUrl,
      // Mock for every runtime but the payments one. The sandbox provider
      // additionally needs its store, variant mapping and secrets — all
      // placeholders that only mean anything to the loopback stub — and the
      // API base url that points the adapter at it. The reader refuses that
      // override outside loopback, and refuses the sandbox provider entirely
      // under NODE_ENV=production, so no configuration here can reach Lemon
      // Squeezy.
      PAYMENT_PROVIDER: runtime.paymentProvider,
      ...(runtime.paymentProvider === 'lemon-squeezy-test'
        ? {
            LEMON_SQUEEZY_API_KEY: E2E_LEMON_API_KEY,
            LEMON_SQUEEZY_STORE_ID: E2E_LEMON_STORE_ID,
            LEMON_SQUEEZY_WEBHOOK_SECRET: E2E_LEMON_WEBHOOK_SECRET,
            LEMON_SQUEEZY_VARIANT_MAP: `${E2E_LEMON_PACKAGE_SLUG}:${E2E_LEMON_VARIANT_ID}`,
            LEMON_SQUEEZY_API_BASE_URL: lemonStubUrl,
          }
        : {}),
    },
  };
}

/**
 * The stand-in sandbox API. Started like any other server in the suite so
 * Playwright waits for its health endpoint before the first navigation.
 */
function lemonSqueezyStubServer() {
  return {
    command: 'pnpm exec tsx src/lemon-stub.ts',
    cwd: resolve(repoRoot, 'e2e'),
    url: `${lemonStubUrl}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: { ...process.env, LEMON_STUB_PORT: String(lemonStubPort) },
  };
}

function nextServer(runtime: Runtime, app: 'web' | 'admin') {
  const port = app === 'web' ? runtime.ports.web : runtime.ports.admin;

  return {
    command: `pnpm exec next start --port ${port} --hostname 127.0.0.1`,
    cwd: app === 'web' ? webDir : adminDir,
    url: app === 'web' ? runtime.webUrl : runtime.adminUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: {
      ...sharedEnv,
      // Server-side calls resolve API_INTERNAL_URL first, so each Next instance
      // talks to its own runtime's API even though both apps were built once.
      API_INTERNAL_URL: runtime.apiUrl,
      NEXT_PUBLIC_API_URL: runtime.apiUrl,
      // The web app reads the same flag to decide what its forms and its
      // confirmation screen say, so it has to agree with its own API.
      PROVIDER_CLAIM_ENABLED: String(runtime.providerClaim),
    },
  };
}

export default defineConfig({
  testDir: './tests',
  outputDir: resolve(artifactsDir, 'test-results'),
  globalTeardown: './src/global-teardown.ts',

  /**
   * Serial, single worker, on purpose.
   *
   * Every actor drives the real API against one shared database, and several
   * checks are about global state — "no refund transaction exists at all",
   * "this provider's matching list holds exactly one request". Fixtures are
   * uniquely named so parallelism is reachable later, but correctness comes
   * first and the whole suite still runs in a couple of minutes.
   */
  fullyParallel: false,
  workers: 1,

  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(artifactsDir, 'report'), open: 'never' }],
  ],

  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    // No baseURL: a test that meant to visit the phone-gate runtime and
    // accidentally hit the primary one would be a silent false pass, so every
    // navigation names its runtime explicitly.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    apiServer(primaryRuntime),
    nextServer(primaryRuntime, 'web'),
    nextServer(primaryRuntime, 'admin'),
    apiServer(phoneGateRuntime),
    nextServer(phoneGateRuntime, 'web'),
    nextServer(phoneGateRuntime, 'admin'),
    apiServer(contactSharingRuntime),
    nextServer(contactSharingRuntime, 'web'),
    nextServer(contactSharingRuntime, 'admin'),
    apiServer(providerClaimRuntime),
    nextServer(providerClaimRuntime, 'web'),
    nextServer(providerClaimRuntime, 'admin'),
    lemonSqueezyStubServer(),
    apiServer(lemonSqueezyRuntime),
    nextServer(lemonSqueezyRuntime, 'web'),
    nextServer(lemonSqueezyRuntime, 'admin'),
  ],
});

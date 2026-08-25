import { resolve } from 'node:path';

/**
 * The two application runtimes the suite drives.
 *
 * REQUIRE_PHONE_VERIFICATION is read from the environment on every call, so a
 * single API process can only ever represent one side of that flag. Rather than
 * restarting servers mid-suite — which would make the tests depend on process
 * lifecycle timing — the suite runs both sides at once on separate ports:
 *
 *   primary    the shipped default (gate off): the marketplace journey and the
 *              access/error checks, plus the flag=false comparison case.
 *   phoneGate  the same code with the gate on: the phone-verification journey.
 *
 * Both APIs share one `_e2e` database. That is deliberate — it keeps one
 * migration and one truncation for the whole suite, and no test asserts on
 * rows another runtime created, because every fixture is uniquely named.
 *
 * Ports sit in the 32xx range so a running `docker compose` stack (3000-3002)
 * is never disturbed, and are overridable for CI runners that need otherwise.
 */

/**
 * `__dirname`, not `import.meta.url`: Playwright transpiles the config and its
 * imports to CommonJS, and an `import.meta` reference would make Node treat
 * this file as ESM and fail on the transpiled `exports`. The package stays
 * CommonJS so one form works for both Playwright and the tsx-run scripts.
 */
const packageRoot = resolve(__dirname, '..');

export const repoRoot = resolve(packageRoot, '..');
export const artifactsDir = resolve(packageRoot, '.artifacts');

/**
 * Where the test SMS transport writes what it "sent". Shared by the API
 * processes (via NOTIFICATION_OUTBOX_DIR) and by the tests that read the
 * one-time codes back.
 */
export const outboxDir = resolve(artifactsDir, 'outbox');

export type RuntimePorts = {
  api: number;
  web: number;
  admin: number;
};

export type ContactSharing =
  | { enabled: false }
  | { enabled: true; disclosureUrl: string; disclosureVersion: string };

export type PaymentProviderKind = 'mock' | 'lemon-squeezy-test';

export type Runtime = {
  name: string;
  ports: RuntimePorts;
  apiUrl: string;
  webUrl: string;
  adminUrl: string;
  requirePhoneVerification: boolean;
  contactSharing: ContactSharing;
  providerClaim: boolean;
  paymentProvider: PaymentProviderKind;
};

/**
 * The stand-in for the Lemon Squeezy sandbox API (see lemon-stub.ts).
 *
 * The suite never contacts a payment provider. The API process on the payments
 * runtime is pointed at this loopback server, which the configuration reader
 * only accepts for loopback and only outside production.
 */
export const lemonStubPort = port(process.env.E2E_LEMON_STUB_PORT, 3299);
export const lemonStubUrl = `http://127.0.0.1:${lemonStubPort}`;

/**
 * Sandbox settings for the payments runtime.
 *
 * Placeholders, deliberately. Every one of them is a syntactically valid value
 * that was never issued by anybody: the store, the variant and the key exist
 * only inside the stub above, and the webhook secret is what the suite signs
 * its own simulated deliveries with. No real credential may ever appear here —
 * this file is tracked.
 */
export const E2E_LEMON_STORE_ID = '424242';
export const E2E_LEMON_VARIANT_ID = '778899';
export const E2E_LEMON_PACKAGE_SLUG = 'e2e-kredi-paketi';
export const E2E_LEMON_API_KEY = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.${'e2ePlaceholderNotARealCredential'}`;
export const E2E_LEMON_WEBHOOK_SECRET = 'e2e-placeholder-webhook-secret';

/**
 * A placeholder destination, deliberately not a legal text.
 *
 * What the suite exercises is the product rule — the feature refuses to run
 * without an https URL and a version, and the form makes the customer confirm
 * having read whatever is behind that link. Writing the disclosure itself is
 * not this repository's job, so the URL points at example.test and is never
 * fetched.
 */
export const E2E_DISCLOSURE_URL = 'https://example.test/taktic/contact-disclosure';
export const E2E_DISCLOSURE_VERSION = 'e2e-v1';

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRuntime(
  name: string,
  ports: RuntimePorts,
  requirePhoneVerification: boolean,
  contactSharing: ContactSharing = { enabled: false },
  providerClaim = false,
  paymentProvider: PaymentProviderKind = 'mock',
): Runtime {
  return {
    name,
    ports,
    apiUrl: `http://127.0.0.1:${ports.api}`,
    webUrl: `http://127.0.0.1:${ports.web}`,
    adminUrl: `http://127.0.0.1:${ports.admin}`,
    requirePhoneVerification,
    contactSharing,
    providerClaim,
    paymentProvider,
  };
}

export const primaryRuntime = buildRuntime(
  'primary',
  {
    api: port(process.env.E2E_API_PORT, 3201),
    web: port(process.env.E2E_WEB_PORT, 3200),
    admin: port(process.env.E2E_ADMIN_PORT, 3202),
  },
  false,
);

export const phoneGateRuntime = buildRuntime(
  'phone-gate',
  {
    api: port(process.env.E2E_GATE_API_PORT, 3211),
    web: port(process.env.E2E_GATE_WEB_PORT, 3210),
    admin: port(process.env.E2E_GATE_ADMIN_PORT, 3212),
  },
  true,
);

/**
 * The same code with CONTACT_SHARING_ENABLED on.
 *
 * A third stack for the same reason the phone gate has a second one: the flag
 * is read per call from the API's environment, so one process cannot represent
 * both sides. Running them side by side is what lets the suite show that the
 * difference between "no contact details anywhere" and "each party sees the
 * other" is this flag and nothing else.
 */
export const contactSharingRuntime = buildRuntime(
  'contact-sharing',
  {
    api: port(process.env.E2E_CONTACT_API_PORT, 3221),
    web: port(process.env.E2E_CONTACT_WEB_PORT, 3220),
    admin: port(process.env.E2E_CONTACT_ADMIN_PORT, 3222),
  },
  false,
  {
    enabled: true,
    disclosureUrl: E2E_DISCLOSURE_URL,
    disclosureVersion: E2E_DISCLOSURE_VERSION,
  },
);

/**
 * The same code with PROVIDER_CLAIM_ENABLED on.
 *
 * A fourth stack for the reason the other two extra ones exist: the flag is
 * read per call from the API's environment and per render from the web app's,
 * so one process cannot represent both sides. Running them side by side is what
 * lets the suite show that the difference between "a guest application is a
 * dead record" and "its applicant can take it over" is this flag and nothing
 * else — the primary runtime keeps the flag off and covers exactly that.
 */
export const providerClaimRuntime = buildRuntime(
  'provider-claim',
  {
    api: port(process.env.E2E_CLAIM_API_PORT, 3231),
    web: port(process.env.E2E_CLAIM_WEB_PORT, 3230),
    admin: port(process.env.E2E_CLAIM_ADMIN_PORT, 3232),
  },
  false,
  { enabled: false },
  true,
);

/**
 * The same code with PAYMENT_PROVIDER=lemon-squeezy-test.
 *
 * A fifth stack for the reason the other three extra ones exist: the switch is
 * read from the API's environment, so one process cannot represent both sides.
 * Running them side by side is what lets the suite show that the difference
 * between the in-app mock checkout and a hosted sandbox one is this variable
 * and nothing else — the primary runtime keeps the mock provider and the
 * marketplace journey covers it.
 *
 * Its API talks to the loopback stub above, never to Lemon Squeezy.
 */
export const lemonSqueezyRuntime = buildRuntime(
  'lemon-squeezy-test',
  {
    api: port(process.env.E2E_PAYMENTS_API_PORT, 3241),
    web: port(process.env.E2E_PAYMENTS_WEB_PORT, 3240),
    admin: port(process.env.E2E_PAYMENTS_ADMIN_PORT, 3242),
  },
  false,
  { enabled: false },
  false,
  'lemon-squeezy-test',
);

export const runtimes = [
  primaryRuntime,
  phoneGateRuntime,
  contactSharingRuntime,
  providerClaimRuntime,
  lemonSqueezyRuntime,
];

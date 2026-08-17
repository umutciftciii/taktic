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

export type Runtime = {
  name: string;
  ports: RuntimePorts;
  apiUrl: string;
  webUrl: string;
  adminUrl: string;
  requirePhoneVerification: boolean;
  contactSharing: ContactSharing;
};

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
): Runtime {
  return {
    name,
    ports,
    apiUrl: `http://127.0.0.1:${ports.api}`,
    webUrl: `http://127.0.0.1:${ports.web}`,
    adminUrl: `http://127.0.0.1:${ports.admin}`,
    requirePhoneVerification,
    contactSharing,
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

export const runtimes = [primaryRuntime, phoneGateRuntime, contactSharingRuntime];

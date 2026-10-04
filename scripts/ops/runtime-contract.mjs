#!/usr/bin/env node
// The deployed runtime contract, checked on the resolved Compose configuration
// before a deploy stops anything (STAGING-CUTOVER-BLOCKERS-001).
//
//   docker compose -f docker-compose.prod.yml --profile tools config --format json \
//     | node scripts/ops/runtime-contract.mjs --environment staging [--project <name>] \
//         --next-public-api-url <url> [--next-public-web-url <url>]
//
// It reads what the containers will actually receive — the file after every
// ${VAR} substitution from the host's .env and shell — and answers, variable by
// variable, whether that configuration is one this deployment may run. It is
// the static half of the preflight's configuration gate; the other half runs
// the API's own boot checks inside the image (apps/api/src/boot-config-check.ts).
// Both run before the API is stopped and before any migration, so a
// configuration the new build would refuse is never discovered by a new API
// that fails to come up on an already-migrated database.
//
// Output is one line per check: the variable's NAME and PASS, WARN or FAIL,
// with a reason that never contains a value. The only values ever printed are
// the expected ones this file states itself (an environment name, a project
// name). The final line is `runtime-contract: OK` or
// `runtime-contract: <n> failure(s)`.
//
// NEXT_PUBLIC_API_URL and NEXT_PUBLIC_WEB_URL are build arguments, not
// container environment; the preflight passes the host's (public) values as
// --next-public-api-url / --next-public-web-url.
//
// Exit status: 0 contract holds, 1 a check failed, 2 the check could not run.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEPLOYED_ENVIRONMENTS = ['staging', 'production'];

/** The project that owns each deployment's volumes, when the operator names none. */
export const DEFAULT_PROJECT_FOR_ENVIRONMENT = { staging: 'taktic-staging' };

/**
 * The payment providers each deployment may run. Production has no live
 * provider in this build, so it may only run the mock; staging may also run
 * Lemon Squeezy's sandbox. Mirrors isSandboxPaymentProviderPermitted in
 * apps/api/src/modules/payments/payment-provider.config.ts.
 */
export const PAYMENT_PROVIDERS_FOR_ENVIRONMENT = {
  staging: ['mock', 'lemon-squeezy-test'],
  production: ['mock'],
};

/** What the sandbox provider needs to boot (lemon-squeezy.config.ts). */
export const LEMON_SQUEEZY_REQUIRED = [
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
];

/** Any of these set at all means "take real money"; the API refuses to boot. */
export const REFUSED_LIVE_MODE_KEYS = [
  'LEMON_SQUEEZY_LIVE_ENABLED',
  'LEMON_SQUEEZY_LIVE_API_KEY',
  'LEMON_SQUEEZY_LIVE_STORE_ID',
  'PAYMENT_LIVE_ENABLED',
];

/**
 * The published development key (promotion-fingerprint.ts). A deployment that
 * carries it has no secret at all. runtime-contract.test.mjs keeps the two in step.
 */
export const DEVELOPMENT_FINGERPRINT_KEY = 'taktic-local-development-promotion-fingerprint-key-not-secret';
export const FINGERPRINT_KEY_MIN_LENGTH = 32;

/** Public addresses the API must know: links in mail, CORS, cookies. */
export const API_PUBLIC_URL_KEYS = ['API_PUBLIC_URL', 'WEB_APP_URL', 'WEB_ORIGIN', 'ADMIN_ORIGIN'];

/** The only sender the production build accepts (resend.config.ts). */
export const PRODUCTION_EMAIL_SENDER = 'noreply@notify.taktick.com.tr';

function environmentOf(service) {
  const env = service?.environment ?? {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(
    env.map((entry) => {
      const text = String(entry);
      const at = text.indexOf('=');
      return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
    }),
  );
}

function value(env, key) {
  const raw = env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Why a URL cannot be a deployment's public address, or null when it can. */
export function publicUrlProblem(raw) {
  if (!raw) return 'not set';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'not an absolute URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0') {
    return 'points at this machine, not a public address';
  }
  return null;
}

/**
 * The contract, as a list of results. Pure: no I/O, so the tests drive it with
 * hand-written configurations.
 *
 *   config       `docker compose config --format json`
 *   environment  staging | production — what the operator says this host is
 *   project      the compose project that must own the volumes
 *   buildEnv     NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WEB_URL, the build arguments
 */
export function checkRuntimeContract(config, { environment, project, buildEnv = {} }) {
  const results = [];
  const pass = (name, detail = '') => results.push({ name, status: 'PASS', detail });
  const warn = (name, detail) => results.push({ name, status: 'WARN', detail });
  const fail = (name, detail) => results.push({ name, status: 'FAIL', detail });

  if (!DEPLOYED_ENVIRONMENTS.includes(environment)) {
    fail('--environment', `must be one of ${DEPLOYED_ENVIRONMENTS.join(', ')}`);
    return results;
  }

  const expectedProject = project || DEFAULT_PROJECT_FOR_ENVIRONMENT[environment];
  if (!expectedProject) {
    fail('COMPOSE_PROJECT_NAME', `no expected project for ${environment}; pass --project <name>`);
  } else if (config.name !== expectedProject) {
    fail('COMPOSE_PROJECT_NAME', `is not ${expectedProject} (a different project means different, empty volumes)`);
  } else {
    pass('COMPOSE_PROJECT_NAME', `= ${expectedProject}`);
  }

  const api = environmentOf(config.services?.api);
  const web = environmentOf(config.services?.web);

  for (const [who, env] of [['api', api], ['web', web]]) {
    if (value(env, 'APP_ENVIRONMENT') === environment) {
      pass(`APP_ENVIRONMENT (${who})`, `= ${environment}`);
    } else {
      fail(`APP_ENVIRONMENT (${who})`, `is not ${environment}`);
    }
  }

  // The deployed runtime is the production build, run as production. A
  // deployment that needs a development-mode process is not using this file.
  if (value(api, 'NODE_ENV') === 'production') {
    pass('NODE_ENV (api)', '= production');
  } else {
    fail('NODE_ENV (api)', 'is not production (docker-compose.prod.yml states it literally; this configuration is not that file)');
  }
  const nodeEnvProduction = value(api, 'NODE_ENV') === 'production';

  const fingerprintKey = value(api, 'PROMOTION_FINGERPRINT_KEY');
  if (!fingerprintKey) {
    fail('PROMOTION_FINGERPRINT_KEY', 'not set (the API refuses to boot without it)');
  } else if (fingerprintKey.length < FINGERPRINT_KEY_MIN_LENGTH) {
    fail('PROMOTION_FINGERPRINT_KEY', `shorter than ${FINGERPRINT_KEY_MIN_LENGTH} characters`);
  } else if (fingerprintKey === DEVELOPMENT_FINGERPRINT_KEY) {
    fail('PROMOTION_FINGERPRINT_KEY', 'is the published development key');
  } else {
    pass('PROMOTION_FINGERPRINT_KEY', `set, at least ${FINGERPRINT_KEY_MIN_LENGTH} characters`);
  }
  const fingerprintVersion = value(api, 'PROMOTION_FINGERPRINT_KEY_VERSION');
  if (fingerprintVersion && !/^(?:[1-9]\d{0,2}|1000)$/.test(fingerprintVersion)) {
    fail('PROMOTION_FINGERPRINT_KEY_VERSION', 'must be a whole number from 1 to 1000');
  }

  const provider = value(api, 'PAYMENT_PROVIDER') || 'mock';
  const allowedProviders = PAYMENT_PROVIDERS_FOR_ENVIRONMENT[environment];
  if (allowedProviders.includes(provider)) {
    pass('PAYMENT_PROVIDER', `allowed on ${environment}`);
  } else {
    fail('PAYMENT_PROVIDER', `not allowed on ${environment} (allowed: ${allowedProviders.join(', ')})`);
  }
  if (provider === 'lemon-squeezy-test' && allowedProviders.includes(provider)) {
    const missing = LEMON_SQUEEZY_REQUIRED.filter((key) => !value(api, key));
    for (const key of LEMON_SQUEEZY_REQUIRED) {
      if (missing.includes(key)) fail(key, 'not set (required by PAYMENT_PROVIDER=lemon-squeezy-test)');
    }
    const mode = value(api, 'LEMON_SQUEEZY_MODE');
    if (mode && mode !== 'test') {
      fail('LEMON_SQUEEZY_MODE', 'may only be empty or "test"');
    } else if (missing.length === 0) {
      pass('test-payment contract', `lemon-squeezy-test sandbox on APP_ENVIRONMENT=${environment} under NODE_ENV=production`);
    }
  }
  for (const key of REFUSED_LIVE_MODE_KEYS) {
    if (value(api, key)) fail(key, 'set; live payment collection is not part of this build');
  }

  for (const key of API_PUBLIC_URL_KEYS) {
    const problem = publicUrlProblem(value(api, key));
    if (problem) fail(`${key} (api)`, problem);
    else pass(`${key} (api)`, 'public https address');
  }
  const browserApiProblem = publicUrlProblem((buildEnv.NEXT_PUBLIC_API_URL ?? '').trim());
  if (browserApiProblem) fail('NEXT_PUBLIC_API_URL (build)', browserApiProblem);
  else pass('NEXT_PUBLIC_API_URL (build)', 'public https address');
  const publicWebUrl = (buildEnv.NEXT_PUBLIC_WEB_URL ?? '').trim();
  if (!publicWebUrl) {
    warn('NEXT_PUBLIC_WEB_URL (build)', 'not set; admin links to public provider pages are omitted');
  } else {
    const problem = publicUrlProblem(publicWebUrl);
    if (problem) fail('NEXT_PUBLIC_WEB_URL (build)', problem);
    else pass('NEXT_PUBLIC_WEB_URL (build)', 'public https address');
  }

  // Under NODE_ENV=production the API accepts only a transport that delivers,
  // and only the pinned sender (email-transport.ts, resend.config.ts).
  if (nodeEnvProduction) {
    if (value(api, 'EMAIL_TRANSPORT') !== 'resend') {
      fail('EMAIL_TRANSPORT', 'must be resend under NODE_ENV=production');
    } else {
      pass('EMAIL_TRANSPORT', '= resend');
      if (!value(api, 'RESEND_API_KEY')) fail('RESEND_API_KEY', 'not set');
      else pass('RESEND_API_KEY', 'set');
    }
    const from = value(api, 'EMAIL_FROM');
    const address = (from.match(/<([^>]+)>\s*$/)?.[1] ?? from).trim().toLowerCase();
    if (address !== PRODUCTION_EMAIL_SENDER) fail('EMAIL_FROM', `must send as ${PRODUCTION_EMAIL_SENDER}`);
    else pass('EMAIL_FROM', `sends as ${PRODUCTION_EMAIL_SENDER}`);
  }

  // Turnstile: an unset mode on a deployed environment is Cloudflare, which
  // needs its secret and hostnames (API) and its site key (web).
  const turnstileMode = value(api, 'TURNSTILE_MODE') || 'cloudflare';
  if (turnstileMode === 'cloudflare') {
    for (const key of ['TURNSTILE_SECRET_KEY', 'TURNSTILE_EXPECTED_HOSTNAMES']) {
      if (value(api, key)) pass(`${key} (api)`, 'set');
      else fail(`${key} (api)`, 'not set (Turnstile runs in cloudflare mode here)');
    }
    if (value(web, 'TURNSTILE_SITE_KEY')) pass('TURNSTILE_SITE_KEY (web)', 'set');
    else fail('TURNSTILE_SITE_KEY (web)', 'not set (the request forms cannot render the widget)');
  } else {
    fail('TURNSTILE_MODE', 'a bypass mode is refused on a deployed environment');
  }

  // Not a boot failure, and not this check's to fix: the build has no SMS
  // transport that delivers, and under NODE_ENV=production the console adapter
  // refuses to "send". Stated so nobody discovers it from a tester.
  if (nodeEnvProduction) {
    warn('SMS transport', 'none delivers under NODE_ENV=production; phone-verification codes are not sent');
  }

  return results;
}

function parseArgs(argv) {
  const options = { environment: '', project: '', nextPublicApiUrl: '', nextPublicWebUrl: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--environment') options.environment = argv[(i += 1)] ?? '';
    else if (arg === '--project') options.project = argv[(i += 1)] ?? '';
    else if (arg === '--next-public-api-url') options.nextPublicApiUrl = argv[(i += 1)] ?? '';
    else if (arg === '--next-public-web-url') options.nextPublicWebUrl = argv[(i += 1)] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readStdin() {
  return new Promise((resolveRead, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolveRead(data));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  let options;
  let config;
  try {
    options = parseArgs(argv);
    config = JSON.parse(await readStdin());
  } catch (error) {
    console.error(`runtime-contract: ${error.message}`);
    return 2;
  }
  const results = checkRuntimeContract(config, {
    environment: options.environment,
    project: options.project,
    buildEnv: { NEXT_PUBLIC_API_URL: options.nextPublicApiUrl, NEXT_PUBLIC_WEB_URL: options.nextPublicWebUrl },
  });
  for (const { name, status, detail } of results) {
    console.log(`${status.padEnd(4)} ${name}${detail ? `: ${detail}` : ''}`);
  }
  const failures = results.filter((result) => result.status === 'FAIL').length;
  if (failures) {
    console.log(`runtime-contract: ${failures} failure(s)`);
    return 1;
  }
  console.log('runtime-contract: OK');
  return 0;
}

// Compared by real path, as in compose-security.mjs: a deploy stages these
// scripts into a temporary directory reached through a symlink on macOS.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`runtime-contract: ${error.message}`);
      process.exitCode = 2;
    },
  );
}

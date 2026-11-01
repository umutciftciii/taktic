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

/**
 * OBS-ALERT-001: the operations alert channels' shapes. Mirrors
 * apps/api/src/modules/ops-alerts/ops-alert.config.ts, so a value the API
 * would refuse at boot is refused here first.
 */
export const OPS_ALERT_TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
export const OPS_ALERT_TELEGRAM_CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const OPS_ALERT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// OBS-ALERT-002: mirrors apps/api/src/modules/ops-alerts/recipient-crypto.config.ts
// (a source-reading test pins these). The key text is 32 bytes of published,
// non-secret text; the API refuses it, and so does the contract.
export const DEVELOPMENT_RECIPIENT_ENC_KEY_TEXT = 'taktic-dev-recipient-not-secret!';
export const DEVELOPMENT_RECIPIENT_HMAC_KEY = 'taktic-local-development-recipient-hmac-key-not-secret';
export const RECIPIENT_HMAC_KEY_MIN_LENGTH = 32;
const RECIPIENT_KEY_ID_PATTERN = /^v[1-9]\d{0,3}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** What the sandbox provider needs to boot (lemon-squeezy.config.ts). */
export const LEMON_SQUEEZY_REQUIRED = [
  'LEMON_SQUEEZY_API_KEY',
  'LEMON_SQUEEZY_STORE_ID',
  'LEMON_SQUEEZY_WEBHOOK_SECRET',
  'LEMON_SQUEEZY_VARIANT_MAP',
];

/**
 * The deprecated scheduler switches (apps/api/src/common/legacy-scheduler-flags.ts).
 * They decide nothing — whether a job runs is an OperationsSettings row — and
 * the API logs a deprecation warning at every boot for each one that is set to
 * anything at all, "false" included. docker-compose.prod.yml forwards them
 * empty; a non-empty value here comes from the host's .env.
 */
export const LEGACY_SCHEDULER_FLAGS = [
  'ENTITLEMENT_RENEWAL_SCHEDULER_ENABLED',
  'UNVIEWED_OFFER_REFUND_ENABLED',
  'REQUEST_EXPIRY_SCHEDULER_ENABLED',
  'REQUEST_REMINDER_SCHEDULER_ENABLED',
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
  const admin = environmentOf(config.services?.admin);

  for (const [who, env] of [['api', api], ['web', web], ['admin', admin]]) {
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
  // needs its secret and hostnames (API) and its site key (web, and since
  // SEC-AUTH-ABUSE-001 the admin panel, whose sign-in carries a token too).
  const turnstileMode = value(api, 'TURNSTILE_MODE') || 'cloudflare';
  if (turnstileMode === 'cloudflare') {
    for (const key of ['TURNSTILE_SECRET_KEY', 'TURNSTILE_EXPECTED_HOSTNAMES']) {
      if (value(api, key)) pass(`${key} (api)`, 'set');
      else fail(`${key} (api)`, 'not set (Turnstile runs in cloudflare mode here)');
    }
    if (value(web, 'TURNSTILE_SITE_KEY')) pass('TURNSTILE_SITE_KEY (web)', 'set');
    else fail('TURNSTILE_SITE_KEY (web)', 'not set (the request and sign-in forms cannot render the widget)');
    if (value(admin, 'TURNSTILE_SITE_KEY')) pass('TURNSTILE_SITE_KEY (admin)', 'set');
    else fail('TURNSTILE_SITE_KEY (admin)', 'not set (the panel sign-in renders closed: nobody could sign in to the admin panel)');
    for (const result of turnstileHostnameCoverage(api)) results.push(result);
  } else {
    fail('TURNSTILE_MODE', 'a bypass mode is refused on a deployed environment');
  }
  for (const [who, env] of [['web', web], ['admin', admin]]) {
    const mode = value(env, 'TURNSTILE_MODE');
    if (mode && mode !== 'cloudflare') {
      fail(`TURNSTILE_MODE (${who})`, 'a bypass mode renders the forms closed on a deployed environment');
    }
  }

  // SEC-AUTH-ABUSE-001: the sign-in limits count the client's address. Unless
  // the API trusts the hop in front of it and the web and the panel forward
  // the address they received, every sign-in arrives from the web server's
  // own address, and the address lock becomes one lock for everybody: a
  // stranger's fifty wrong passwords would lock the operators out of the panel
  // too. Refused here, before anything is stopped.
  if (value(api, 'TRUST_PROXY')) pass('TRUST_PROXY (api)', 'set');
  else fail('TRUST_PROXY (api)', 'not set (sign-in limits would count the web server, not the visitor: one address lock would lock everybody out, staff included)');
  for (const [who, env] of [['web', web], ['admin', admin]]) {
    if (value(env, 'WEB_TRUST_PROXY') === 'true') pass(`WEB_TRUST_PROXY (${who})`, '= true');
    else fail(`WEB_TRUST_PROXY (${who})`, 'is not "true" (the client address is not forwarded; see TRUST_PROXY)');
  }

  // Deprecated scheduler switches: harmless, but each one set costs a WARN
  // line at every API boot, so the contract names it for removal.
  const legacySet = LEGACY_SCHEDULER_FLAGS.filter((flag) => value(api, flag));
  for (const flag of legacySet) {
    warn(flag, 'set but has no effect (the switch is an OperationsSettings row); the API warns at every boot — remove it from the host .env');
  }
  if (!legacySet.length) pass('legacy scheduler switches', 'none set; the database settings are the only source');

  for (const result of opsAlertChannelCoverage(api, environment)) results.push(result);
  for (const result of opsAlertRecipientKeyCoverage(api, environment)) results.push(result);

  // SMS (apps/api/src/modules/notifications/sms-transport.ts). The build has
  // no SMS provider. The recorder transport is test-only and refused under
  // NODE_ENV=production. The console stand-in follows the shared sandbox rule:
  // on staging it writes each code to the API container's log (read by the
  // host operator with `docker logs`), on production it refuses every send
  // and writes no code.
  if (value(api, 'NOTIFICATION_OUTBOX_DIR')) {
    fail('NOTIFICATION_OUTBOX_DIR', 'set; the recording transport is test-only and refused on a deployed host');
  } else if (environment === 'staging') {
    pass('SMS transport', 'console stand-in: codes go to the API container log only (docker logs), never to a phone or a response');
  } else {
    warn('SMS transport', 'no SMS provider in this build; on production the console adapter refuses every send and logs no code');
  }

  return results;
}

/**
 * OBS-ALERT-001: where operations alerts go. A malformed value or half of the
 * Telegram pair is a boot refusal everywhere; no channel at all is a boot
 * refusal on production and a WARN on staging (alerts are recorded, sent
 * nowhere). Names only: never the address, the chat or the token.
 */
export function opsAlertChannelCoverage(api, environment) {
  const results = [];
  const email = value(api, 'OPS_ALERT_EMAIL');
  const token = value(api, 'OPS_ALERT_TELEGRAM_BOT_TOKEN');
  const chat = value(api, 'OPS_ALERT_TELEGRAM_CHAT_ID');
  let channels = 0;

  if (email) {
    if (OPS_ALERT_EMAIL_PATTERN.test(email)) {
      results.push({ name: 'OPS_ALERT_EMAIL', status: 'PASS', detail: 'set' });
      channels += 1;
    } else {
      results.push({ name: 'OPS_ALERT_EMAIL', status: 'FAIL', detail: 'not a plain e-mail address (the API refuses to boot)' });
    }
  }
  if (Boolean(token) !== Boolean(chat)) {
    results.push({
      name: 'OPS_ALERT_TELEGRAM_BOT_TOKEN/OPS_ALERT_TELEGRAM_CHAT_ID',
      status: 'FAIL',
      detail: 'set together or not at all (the API refuses to boot)',
    });
  } else if (token && chat) {
    const tokenOk = OPS_ALERT_TELEGRAM_TOKEN_PATTERN.test(token);
    const chatOk = OPS_ALERT_TELEGRAM_CHAT_ID_PATTERN.test(chat);
    if (!tokenOk) results.push({ name: 'OPS_ALERT_TELEGRAM_BOT_TOKEN', status: 'FAIL', detail: 'not a Telegram bot token (the API refuses to boot)' });
    if (!chatOk) results.push({ name: 'OPS_ALERT_TELEGRAM_CHAT_ID', status: 'FAIL', detail: 'not a Telegram chat id (the API refuses to boot)' });
    if (tokenOk && chatOk) {
      results.push({ name: 'OPS_ALERT_TELEGRAM', status: 'PASS', detail: 'bot token and chat id set' });
      channels += 1;
    }
  }

  if (channels === 0 && !results.some((result) => result.status === 'FAIL')) {
    if (environment === 'production') {
      results.push({ name: 'OPS_ALERT channels', status: 'FAIL', detail: 'none set; production requires at least one (the API refuses to boot)' });
    } else {
      results.push({ name: 'OPS_ALERT channels', status: 'WARN', detail: 'none set; operations alerts are recorded but sent nowhere' });
    }
  }
  return results;
}

/**
 * OBS-ALERT-002: the keys behind managed alert recipients. Required on every
 * deployed environment; a development value or a malformed one is a boot
 * refusal in the API, so it is a FAIL here. Local stacks are not asked.
 * The detail says how many keys and which versions, never a key.
 */
export function opsAlertRecipientKeyCoverage(api, environment) {
  if (!DEPLOYED_ENVIRONMENTS.includes(environment)) return [];
  const name = 'OPS_ALERT_RECIPIENT keys';
  const fail = (detail) => [{ name, status: 'FAIL', detail }];
  const keys = value(api, 'OPS_ALERT_RECIPIENT_ENC_KEYS');
  const active = value(api, 'OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE');
  const hmacKey = value(api, 'OPS_ALERT_RECIPIENT_HMAC_KEY');
  const rawVersion = value(api, 'OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION');

  const missing = [
    ['OPS_ALERT_RECIPIENT_ENC_KEYS', keys],
    ['OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE', active],
    ['OPS_ALERT_RECIPIENT_HMAC_KEY', hmacKey],
  ].filter(([, v]) => !v);
  if (missing.length) {
    return missing.map(([key]) => ({ name: key, status: 'FAIL', detail: 'not set (the API refuses to boot without it; recipient addresses are encrypted at rest)' }));
  }

  const version = rawVersion ? Number(rawVersion) : 1;
  if (!Number.isInteger(version) || version < 1 || version > 1000) {
    return fail('OPS_ALERT_RECIPIENT_HMAC_KEY_VERSION must be a whole number from 1 to 1000');
  }
  if (hmacKey.length < RECIPIENT_HMAC_KEY_MIN_LENGTH) {
    return fail(`OPS_ALERT_RECIPIENT_HMAC_KEY shorter than ${RECIPIENT_HMAC_KEY_MIN_LENGTH} characters`);
  }
  if (hmacKey === DEVELOPMENT_RECIPIENT_HMAC_KEY) {
    return fail('OPS_ALERT_RECIPIENT_HMAC_KEY is the published development key');
  }

  const ids = new Set();
  const development = Buffer.from(DEVELOPMENT_RECIPIENT_ENC_KEY_TEXT, 'utf8');
  for (const entry of keys.split(',')) {
    const separator = entry.indexOf(':');
    const id = separator === -1 ? '' : entry.slice(0, separator).trim();
    const encoded = separator === -1 ? '' : entry.slice(separator + 1).trim();
    if (!RECIPIENT_KEY_ID_PATTERN.test(id)) return fail('OPS_ALERT_RECIPIENT_ENC_KEYS must be a comma-separated list of v<n>:<base64 key> entries');
    if (ids.has(id)) return fail('OPS_ALERT_RECIPIENT_ENC_KEYS has a duplicate key id');
    if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) return fail('OPS_ALERT_RECIPIENT_ENC_KEYS has an entry whose key is not base64');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) return fail('OPS_ALERT_RECIPIENT_ENC_KEYS has an entry that is not exactly 32 bytes');
    if (key.equals(development)) return fail('OPS_ALERT_RECIPIENT_ENC_KEYS is the published development keyring');
    ids.add(id);
  }
  if (!ids.has(active)) return fail('OPS_ALERT_RECIPIENT_ENC_KEY_ACTIVE is not in OPS_ALERT_RECIPIENT_ENC_KEYS');

  return [{ name, status: 'PASS', detail: `keyring ${active} (${ids.size} ${ids.size === 1 ? 'key' : 'keys'}), hmac v${version}` }];
}

/**
 * Whether the API accepts a token solved on each public origin the forms are
 * served from. A token is refused unless its hostname is listed
 * (cloudflare-turnstile.verifier.ts), so an admin origin missing from the list
 * is a panel nobody can sign in to — found here, not by the first operator
 * after the deploy. Names, never values: the result says which origin's
 * hostname is missing, not what it is.
 */
export function turnstileHostnameCoverage(api) {
  const results = [];
  const listed = new Set(
    value(api, 'TURNSTILE_EXPECTED_HOSTNAMES')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!listed.size) return results;
  for (const key of ['WEB_ORIGIN', 'ADMIN_ORIGIN']) {
    let hostname = '';
    try {
      hostname = new URL(value(api, key)).hostname.toLowerCase();
    } catch {
      continue; // an unusable origin is already a FAIL of its own above
    }
    const name = `TURNSTILE_EXPECTED_HOSTNAMES ∋ ${key}`;
    if (listed.has(hostname)) results.push({ name, status: 'PASS', detail: `lists the ${key} hostname` });
    else
      results.push({
        name,
        status: 'FAIL',
        detail:
          key === 'ADMIN_ORIGIN'
            ? 'does not list the ADMIN_ORIGIN hostname (every admin sign-in would be refused: HOSTNAME_MISMATCH)'
            : 'does not list the WEB_ORIGIN hostname (every web form would be refused: HOSTNAME_MISMATCH)',
      });
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

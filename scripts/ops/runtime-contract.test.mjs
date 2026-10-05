// node --test scripts/ops/runtime-contract.test.mjs
//
// The deployed runtime contract (runtime-contract.mjs). The rule tests feed
// hand-written resolved configurations, so each rule is shown to fire and no
// failure ever prints a value. The repository tests resolve the real
// docker-compose.prod.yml — skipped, loudly, where no Docker CLI exists — and
// prove that a host .env carrying the staging contract passes, and that the
// file itself produces NODE_ENV=production when the host says nothing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveConfig } from './compose-security.mjs';
import {
  DEVELOPMENT_FINGERPRINT_KEY,
  FINGERPRINT_KEY_MIN_LENGTH,
  LEGACY_SCHEDULER_FLAGS,
  PRODUCTION_EMAIL_SENDER,
  checkRuntimeContract,
  publicUrlProblem,
} from './runtime-contract.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SECRET_FINGERPRINT = 'placeholder-fingerprint-key-not-a-secret-0001';
const SECRET_VALUES = [
  SECRET_FINGERPRINT,
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.placeholderNotARealCredential',
  'placeholder-webhook-secret-not-real',
  're_placeholderNotARealKey',
  '1x0000000000000000000000000000000AA',
];

/** The staging host's configuration as `docker compose config` resolves it. */
function stagingConfig() {
  return {
    name: 'taktic-staging',
    services: {
      api: {
        environment: {
          NODE_ENV: 'production',
          APP_ENVIRONMENT: 'staging',
          PROMOTION_FINGERPRINT_KEY: SECRET_FINGERPRINT,
          PROMOTION_FINGERPRINT_KEY_VERSION: '',
          PAYMENT_PROVIDER: 'lemon-squeezy-test',
          LEMON_SQUEEZY_MODE: '',
          LEMON_SQUEEZY_API_KEY: SECRET_VALUES[1],
          LEMON_SQUEEZY_STORE_ID: '424242',
          LEMON_SQUEEZY_WEBHOOK_SECRET: SECRET_VALUES[2],
          LEMON_SQUEEZY_VARIANT_MAP: 'baslangic:111',
          API_PUBLIC_URL: 'https://api-staging.example.test',
          WEB_APP_URL: 'https://staging.example.test',
          WEB_ORIGIN: 'https://staging.example.test',
          ADMIN_ORIGIN: 'https://admin-staging.example.test',
          EMAIL_TRANSPORT: 'resend',
          RESEND_API_KEY: SECRET_VALUES[3],
          EMAIL_FROM: `Taktick <${PRODUCTION_EMAIL_SENDER}>`,
          TURNSTILE_MODE: '',
          TURNSTILE_SECRET_KEY: SECRET_VALUES[4],
          TURNSTILE_EXPECTED_HOSTNAMES: 'staging.example.test',
        },
      },
      web: { environment: { APP_ENVIRONMENT: 'staging', TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } },
    },
  };
}

const BUILD_ENV = {
  NEXT_PUBLIC_API_URL: 'https://api-staging.example.test',
  NEXT_PUBLIC_WEB_URL: 'https://staging.example.test',
};

function run(config, options = {}) {
  return checkRuntimeContract(config, { environment: 'staging', buildEnv: BUILD_ENV, ...options });
}

function failures(results) {
  return Object.fromEntries(results.filter((r) => r.status === 'FAIL').map((r) => [r.name, r.detail]));
}

function assertNoSecretPrinted(results) {
  const text = results.map((r) => `${r.name} ${r.detail}`).join('\n');
  for (const secret of SECRET_VALUES) assert.ok(!text.includes(secret), 'a secret value reached the output');
}

describe('the staging contract', () => {
  it('passes the production build on staging with the Lemon Squeezy sandbox', () => {
    const results = run(stagingConfig());
    assert.deepEqual(failures(results), {});
    assert.ok(results.some((r) => r.name === 'test-payment contract' && r.status === 'PASS'));
    assertNoSecretPrinted(results);
  });

  it('fails a missing promotion fingerprint key', () => {
    const config = stagingConfig();
    delete config.services.api.environment.PROMOTION_FINGERPRINT_KEY;
    assert.match(failures(run(config)).PROMOTION_FINGERPRINT_KEY, /not set/);
  });

  it('fails a short key, and the published development key, without printing either', () => {
    const config = stagingConfig();
    const short = 's'.repeat(FINGERPRINT_KEY_MIN_LENGTH - 1);
    config.services.api.environment.PROMOTION_FINGERPRINT_KEY = short;
    let results = run(config);
    assert.match(failures(results).PROMOTION_FINGERPRINT_KEY, /shorter than 32 characters/);
    assert.ok(!JSON.stringify(results).includes(short));

    config.services.api.environment.PROMOTION_FINGERPRINT_KEY = DEVELOPMENT_FINGERPRINT_KEY;
    results = run(config);
    assert.match(failures(results).PROMOTION_FINGERPRINT_KEY, /published development key/);
  });

  it('fails a wrong or missing COMPOSE_PROJECT_NAME', () => {
    const config = stagingConfig();
    config.name = 'taktick';
    assert.match(failures(run(config)).COMPOSE_PROJECT_NAME, /is not taktic-staging/);

    config.name = 'taktic-staging';
    assert.match(failures(run(config, { project: 'taktic-other' })).COMPOSE_PROJECT_NAME, /is not taktic-other/);
  });

  it('requires an explicit project for production', () => {
    const config = stagingConfig();
    config.services.api.environment.APP_ENVIRONMENT = 'production';
    config.services.web.environment.APP_ENVIRONMENT = 'production';
    config.services.api.environment.PAYMENT_PROVIDER = 'mock';
    assert.match(failures(run(config, { environment: 'production' })).COMPOSE_PROJECT_NAME, /pass --project/);
  });

  it('fails an APP_ENVIRONMENT that is not the one the operator deploys', () => {
    const config = stagingConfig();
    config.services.api.environment.APP_ENVIRONMENT = 'production';
    config.services.web.environment.APP_ENVIRONMENT = '';
    const failed = failures(run(config));
    assert.match(failed['APP_ENVIRONMENT (api)'], /is not staging/);
    assert.match(failed['APP_ENVIRONMENT (web)'], /is not staging/);
  });

  it('fails a development-mode API (a configuration that is not docker-compose.prod.yml)', () => {
    const config = stagingConfig();
    config.services.api.environment.NODE_ENV = 'development';
    assert.match(failures(run(config))['NODE_ENV (api)'], /not production/);
  });

  it('refuses the sandbox provider on production, and anything unknown anywhere', () => {
    const config = stagingConfig();
    config.name = 'taktic-production';
    config.services.api.environment.APP_ENVIRONMENT = 'production';
    config.services.web.environment.APP_ENVIRONMENT = 'production';
    assert.match(
      failures(run(config, { environment: 'production', project: 'taktic-production' })).PAYMENT_PROVIDER,
      /not allowed on production/,
    );

    const staging = stagingConfig();
    staging.services.api.environment.PAYMENT_PROVIDER = 'lemon-squeezy';
    assert.match(failures(run(staging)).PAYMENT_PROVIDER, /not allowed on staging/);
  });

  it('fails an incomplete sandbox configuration, a non-test mode and any live switch', () => {
    const config = stagingConfig();
    delete config.services.api.environment.LEMON_SQUEEZY_WEBHOOK_SECRET;
    config.services.api.environment.LEMON_SQUEEZY_MODE = 'live';
    config.services.api.environment.PAYMENT_LIVE_ENABLED = 'false';
    const failed = failures(run(config));
    assert.match(failed.LEMON_SQUEEZY_WEBHOOK_SECRET, /not set/);
    assert.match(failed.LEMON_SQUEEZY_MODE, /only be empty or "test"/);
    assert.match(failed.PAYMENT_LIVE_ENABLED, /live payment collection/);
  });

  it('fails public URLs that are missing, plain http or loopback', () => {
    const config = stagingConfig();
    config.services.api.environment.API_PUBLIC_URL = 'http://localhost:3001';
    config.services.api.environment.WEB_ORIGIN = 'http://staging.example.test';
    delete config.services.api.environment.ADMIN_ORIGIN;
    const failed = failures(checkRuntimeContract(config, { environment: 'staging', buildEnv: {} }));
    assert.match(failed['API_PUBLIC_URL (api)'], /not https/);
    assert.match(failed['WEB_ORIGIN (api)'], /not https/);
    assert.match(failed['ADMIN_ORIGIN (api)'], /not set/);
    assert.match(failed['NEXT_PUBLIC_API_URL (build)'], /not set/);
  });

  it('warns, not fails, on a missing NEXT_PUBLIC_WEB_URL', () => {
    const results = checkRuntimeContract(stagingConfig(), {
      environment: 'staging',
      buildEnv: { NEXT_PUBLIC_API_URL: BUILD_ENV.NEXT_PUBLIC_API_URL },
    });
    assert.deepEqual(failures(results), {});
    assert.equal(results.find((r) => r.name === 'NEXT_PUBLIC_WEB_URL (build)').status, 'WARN');
  });

  it('fails what NODE_ENV=production refuses at boot: a non-delivering transport, another sender, no Turnstile secret', () => {
    const config = stagingConfig();
    config.services.api.environment.EMAIL_TRANSPORT = 'console';
    config.services.api.environment.EMAIL_FROM = 'Taktick <hello@notify.taktick.com.tr>';
    delete config.services.api.environment.TURNSTILE_SECRET_KEY;
    delete config.services.web.environment.TURNSTILE_SITE_KEY;
    const failed = failures(run(config));
    assert.match(failed.EMAIL_TRANSPORT, /must be resend/);
    assert.match(failed.EMAIL_FROM, /must send as noreply@notify\.taktick\.com\.tr/);
    assert.match(failed['TURNSTILE_SECRET_KEY (api)'], /not set/);
    assert.match(failed['TURNSTILE_SITE_KEY (web)'], /not set/);
  });

  it('states the SMS stand-in: a PASS on staging, a WARN on production, a FAIL for the recorder', () => {
    let results = run(stagingConfig());
    assert.equal(results.find((r) => r.name === 'SMS transport').status, 'PASS');

    const production = stagingConfig();
    production.name = 'taktic-production';
    production.services.api.environment.APP_ENVIRONMENT = 'production';
    production.services.web.environment.APP_ENVIRONMENT = 'production';
    production.services.api.environment.PAYMENT_PROVIDER = 'mock';
    results = run(production, { environment: 'production', project: 'taktic-production' });
    assert.equal(results.find((r) => r.name === 'SMS transport').status, 'WARN');
    assert.deepEqual(failures(results), {});

    const recorder = stagingConfig();
    recorder.services.api.environment.NOTIFICATION_OUTBOX_DIR = '/tmp/outbox';
    assert.match(failures(run(recorder)).NOTIFICATION_OUTBOX_DIR, /test-only/);
  });

  it('names each deprecated scheduler switch that is set, as a WARN that never prints its value', () => {
    let results = run(stagingConfig());
    assert.equal(results.find((r) => r.name === 'legacy scheduler switches').status, 'PASS');

    const config = stagingConfig();
    config.services.api.environment.REQUEST_EXPIRY_SCHEDULER_ENABLED = 'false';
    config.services.api.environment.UNVIEWED_OFFER_REFUND_ENABLED = 'true';
    config.services.api.environment.REQUEST_REMINDER_SCHEDULER_ENABLED = '';
    results = run(config);
    assert.deepEqual(failures(results), {});
    const warned = results.filter((r) => r.status === 'WARN').map((r) => r.name);
    assert.ok(warned.includes('REQUEST_EXPIRY_SCHEDULER_ENABLED'));
    assert.ok(warned.includes('UNVIEWED_OFFER_REFUND_ENABLED'));
    assert.ok(!warned.includes('REQUEST_REMINDER_SCHEDULER_ENABLED'));
    assert.equal(results.find((r) => r.name === 'legacy scheduler switches'), undefined);
    for (const { detail } of results.filter((r) => LEGACY_SCHEDULER_FLAGS.includes(r.name))) {
      assert.doesNotMatch(detail, /true|false/);
    }
  });

  it('reads list-form environments as well as maps', () => {
    const config = stagingConfig();
    config.services.api.environment = Object.entries(config.services.api.environment).map(([k, v]) => `${k}=${v}`);
    assert.deepEqual(failures(run(config)), {});
  });

  it('classifies public URLs', () => {
    assert.equal(publicUrlProblem('https://staging.taktick.com.tr'), null);
    assert.match(publicUrlProblem('https://127.0.0.1:3001'), /this machine/);
    assert.match(publicUrlProblem('https://localhost'), /this machine/);
    assert.match(publicUrlProblem('staging.taktick.com.tr'), /not an absolute URL/);
  });
});

describe('kept in step with the API', () => {
  const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

  it('the development fingerprint key and minimum length', () => {
    const source = read('apps/api/src/modules/business-registration/promotion-fingerprint.ts');
    assert.match(source, new RegExp(`DEVELOPMENT_FINGERPRINT_KEY = '${DEVELOPMENT_FINGERPRINT_KEY}'`));
    assert.match(source, new RegExp(`FINGERPRINT_KEY_MIN_LENGTH = ${FINGERPRINT_KEY_MIN_LENGTH};`));
  });

  it('the deprecated scheduler switches', () => {
    const source = read('apps/api/src/common/legacy-scheduler-flags.ts');
    const list = source.match(/LEGACY_ENABLE_FLAGS = \[([^\]]*)\]/)?.[1] ?? '';
    assert.deepEqual([...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]), LEGACY_SCHEDULER_FLAGS);
  });

  it('the pinned production sender', () => {
    const source = read('apps/api/src/modules/notifications/resend.config.ts');
    const domain = source.match(/RESEND_VERIFIED_DOMAIN = '([^']+)'/)?.[1];
    assert.equal(`noreply@${domain}`, PRODUCTION_EMAIL_SENDER);
    assert.match(source, /RESEND_PRODUCTION_SENDER_ADDRESS = `noreply@\$\{RESEND_VERIFIED_DOMAIN\}`/);
  });
});

function dockerAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('docker-compose.prod.yml under the contract', { skip: dockerAvailable() ? false : 'no docker CLI' }, () => {
  const stagingHostEnv = {
    COMPOSE_PROJECT_NAME: 'taktic-staging',
    APP_ENVIRONMENT: 'staging',
    PROMOTION_FINGERPRINT_KEY: SECRET_FINGERPRINT,
    PAYMENT_PROVIDER: 'lemon-squeezy-test',
    LEMON_SQUEEZY_API_KEY: SECRET_VALUES[1],
    LEMON_SQUEEZY_STORE_ID: '424242',
    LEMON_SQUEEZY_WEBHOOK_SECRET: SECRET_VALUES[2],
    LEMON_SQUEEZY_VARIANT_MAP: 'baslangic:111',
    API_PUBLIC_URL: 'https://api-staging.example.test',
    WEB_APP_URL: 'https://staging.example.test',
    WEB_ORIGIN: 'https://staging.example.test',
    ADMIN_ORIGIN: 'https://admin-staging.example.test',
    EMAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: SECRET_VALUES[3],
    EMAIL_FROM: `Taktick <${PRODUCTION_EMAIL_SENDER}>`,
    TURNSTILE_SECRET_KEY: SECRET_VALUES[4],
    TURNSTILE_EXPECTED_HOSTNAMES: 'staging.example.test',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  };

  it('a host .env with the staging contract passes, with NODE_ENV=production from the file itself', () => {
    const config = resolveConfig('prod', { extraEnv: stagingHostEnv });
    assert.equal(config.services.api.environment.NODE_ENV, 'production');
    assert.deepEqual(failures(run(config)), {});
  });

  it('forwards no deprecated scheduler switch unless the host .env sets one', () => {
    let config = resolveConfig('prod', { extraEnv: stagingHostEnv });
    for (const flag of LEGACY_SCHEDULER_FLAGS) {
      assert.equal(config.services.api.environment[flag] ?? '', '', `${flag} must resolve empty by default`);
    }
    assert.equal(run(config).find((r) => r.name === 'legacy scheduler switches').status, 'PASS');

    config = resolveConfig('prod', { extraEnv: { ...stagingHostEnv, REQUEST_REMINDER_SCHEDULER_ENABLED: 'false' } });
    const results = run(config);
    assert.equal(results.find((r) => r.name === 'REQUEST_REMINDER_SCHEDULER_ENABLED').status, 'WARN');
    assert.deepEqual(failures(results), {});
  });

  it('the staging .env without the fingerprint key fails before anything runs', () => {
    const { PROMOTION_FINGERPRINT_KEY: _omitted, ...withoutKey } = stagingHostEnv;
    const config = resolveConfig('prod', { extraEnv: withoutKey });
    assert.match(failures(run(config)).PROMOTION_FINGERPRINT_KEY, /not set/);
  });

  it('a leftover API_NODE_ENV=development in the host .env has no effect any more', () => {
    const config = resolveConfig('prod', { extraEnv: { ...stagingHostEnv, API_NODE_ENV: 'development' } });
    assert.equal(config.services.api.environment.NODE_ENV, 'production');
    assert.deepEqual(failures(run(config)), {});
  });
});

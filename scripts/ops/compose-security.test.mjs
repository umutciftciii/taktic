// node --test scripts/ops/compose-security.test.mjs
//
// Two halves. The rule tests feed hand-written configurations to the audit,
// so each rule is shown to fire. The repository tests run the real
// `docker compose config` on the files in this checkout — skipped, loudly,
// where no Docker CLI exists — and prove the acceptance criterion of OPS-006:
// the deployed stack resolves to loopback-only publishing on its own, with no
// override file, whatever the .env says about ports.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { API_ONLY_VARIABLES, auditDev, auditProd, resolveConfig } from './compose-security.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const image = (name) => `taktic-${name}:0000000000000000000000000000000000000000`;
const hardened = { security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'] };
const loopback = (target) => ({ host_ip: '127.0.0.1', target, published: String(target), protocol: 'tcp' });

function cleanProd() {
  return {
    services: {
      postgres: { image: 'postgres:16.6-alpine', volumes: [{ type: 'volume', source: 'taktic-postgres-data', target: '/var/lib/postgresql/data' }] },
      migrate: { image: image('migrate'), ...hardened },
      api: {
        image: image('api'),
        ...hardened,
        ports: [loopback(3001)],
        environment: { APP_ENVIRONMENT: 'staging', DATABASE_URL: 'postgresql://x' },
        volumes: [{ type: 'volume', source: 'taktic-api-uploads', target: '/app/apps/api/uploads' }],
      },
      web: { image: image('web'), ...hardened, ports: [loopback(3000)], environment: { APP_ENVIRONMENT: 'staging' } },
      admin: { image: image('admin'), ...hardened, ports: [loopback(3002)], environment: {} },
    },
  };
}

describe('auditProd rules', () => {
  it('accepts the clean shape', () => {
    assert.deepEqual(auditProd(cleanProd()), []);
  });

  it('rejects a port without host_ip (binds every interface)', () => {
    const config = cleanProd();
    delete config.services.api.ports[0].host_ip;
    assert.match(auditProd(config).join('\n'), /api: port 3001 is published on every host interface/);
  });

  it('rejects 0.0.0.0 and a LAN address', () => {
    const config = cleanProd();
    config.services.web.ports[0].host_ip = '0.0.0.0';
    config.services.admin.ports[0].host_ip = '192.168.1.20';
    const text = auditProd(config).join('\n');
    assert.match(text, /web: port 3000 is published on 0\.0\.0\.0/);
    assert.match(text, /admin: port 3002 is published on 192\.168\.1\.20/);
  });

  it('rejects a published postgres even on loopback', () => {
    const config = cleanProd();
    config.services.postgres.ports = [loopback(5432)];
    assert.match(auditProd(config).join('\n'), /postgres: must not be published/);
  });

  it('rejects bind mounts, dev commands, build sections and foreign images', () => {
    const config = cleanProd();
    config.services.api.volumes.push({ type: 'bind', source: '/srv/taktic', target: '/app' });
    config.services.web.command = ['sh', '-lc', 'pnpm --filter @taktic/web dev'];
    config.services.admin.build = { context: '.' };
    config.services.migrate.image = 'node:22-alpine';
    const text = auditProd(config).join('\n');
    assert.match(text, /api: bind mount \/srv\/taktic -> \/app/);
    assert.match(text, /web: runs a development server command/);
    assert.match(text, /admin: has a build section/);
    assert.match(text, /migrate: image "node:22-alpine"/);
  });

  it('rejects host networking, privileged mode and missing hardening', () => {
    const config = cleanProd();
    config.services.api.network_mode = 'host';
    config.services.web.privileged = true;
    delete config.services.admin.cap_drop;
    const text = auditProd(config).join('\n');
    assert.match(text, /api: network_mode "host"/);
    assert.match(text, /web: privileged container/);
    assert.match(text, /admin: missing cap_drop ALL/);
  });

  it('rejects an API-only secret in web or admin', () => {
    for (const key of API_ONLY_VARIABLES) {
      const config = cleanProd();
      config.services.web.environment[key] = 'x';
      assert.match(auditProd(config).join('\n'), new RegExp(`web: receives ${key}`));
    }
  });

  it('rejects a missing service', () => {
    const config = cleanProd();
    delete config.services.migrate;
    assert.match(auditProd(config).join('\n'), /migrate: service missing/);
  });
});

describe('command line', () => {
  it('audits when run through a symlinked directory (macOS TMPDIR)', () => {
    // A deploy runs these scripts from a staging directory under TMPDIR,
    // which on macOS is reached through /var -> /private/var. The CLI once
    // compared paths as strings there, skipped main() and exited 0 having
    // audited nothing.
    const dir = mkdtempSync(join(tmpdir(), 'taktic-cli-'));
    const link = `${dir}-link`;
    try {
      copyFileSync(join(repoRoot, 'scripts/ops/compose-security.mjs'), join(dir, 'compose-security.mjs'));
      symlinkSync(dir, link);
      const config = JSON.stringify(cleanProd());
      const out = execFileSync(process.execPath, [join(link, 'compose-security.mjs'), 'prod', '--stdin'], { input: config, encoding: 'utf8' });
      assert.match(out, /compose-security: prod stack OK/);
      const leaky = cleanProd();
      leaky.services.web.ports[0].host_ip = '0.0.0.0';
      assert.throws(() =>
        execFileSync(process.execPath, [join(link, 'compose-security.mjs'), 'prod', '--stdin'], { input: JSON.stringify(leaky), stdio: 'pipe' }),
      );
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auditDev rules', () => {
  it('only checks exposure', () => {
    assert.deepEqual(auditDev({ services: { api: { image: 'node:22-alpine', ports: [loopback(3001)] } } }), []);
    assert.equal(auditDev({ services: { postgres: { ports: [{ target: 5432, published: '5433' }] } } }).length, 1);
  });
});

function dockerComposeAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const compose = dockerComposeAvailable();

describe('repository compose files', { skip: compose ? false : 'docker compose CLI not available' }, () => {
  it('docker-compose.prod.yml alone is loopback-only and immutable', () => {
    const config = resolveConfig('prod');
    assert.deepEqual(auditProd(config), []);
    const published = Object.values(config.services).flatMap((s) => s.ports ?? []);
    assert.equal(published.length, 3, 'api, web and admin are the only published ports');
    assert.ok(published.every((p) => p.host_ip === '127.0.0.1'));
  });

  it('port variables cannot widen the bind address', () => {
    for (const hostile of ['0.0.0.0:3001', '3001:3001', '[::]:3001']) {
      let config;
      try {
        config = resolveConfig('prod', { extraEnv: { API_PORT: hostile, WEB_PORT: hostile, ADMIN_PORT: hostile } });
      } catch {
        continue; // Compose refusing the value is as good as loopback.
      }
      assert.deepEqual(auditProd(config), [], `API_PORT=${hostile}`);
    }
  });

  it('an override file next to the prod file is not read', () => {
    // `-f` disables Compose's automatic override, so a docker-compose.override.yml
    // publishing PostgreSQL on 0.0.0.0 changes nothing about the prod config.
    const dir = mkdtempSync(join(tmpdir(), 'taktic-compose-'));
    try {
      copyFileSync(join(repoRoot, 'docker-compose.prod.yml'), join(dir, 'docker-compose.prod.yml'));
      writeFileSync(
        join(dir, 'docker-compose.override.yml'),
        'services:\n  postgres:\n    ports:\n      - "0.0.0.0:5432:5432"\n',
      );
      const run = (...files) =>
        JSON.parse(
          execFileSync('docker', ['compose', '--env-file', '/dev/null', ...files.flatMap((f) => ['-f', f]), '--profile', 'tools', 'config', '--format', 'json'], {
            cwd: dir,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_PROJECT_NAME: 'x', TAKTIC_IMAGE_TAG: 't', APP_ENVIRONMENT: 'staging', POSTGRES_PASSWORD: 'p' },
            encoding: 'utf8',
          }),
        );
      assert.deepEqual(auditProd(run('docker-compose.prod.yml')), []);
      // Control: the same override, named explicitly, is caught — so the
      // clean result above is the override being ignored, not a blind audit.
      assert.match(auditProd(run('docker-compose.prod.yml', 'docker-compose.override.yml')).join('\n'), /postgres: port 5432 is published on 0\.0\.0\.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('docker-compose.prod.yml refuses to resolve without its required values', () => {
    for (const missing of ['COMPOSE_PROJECT_NAME', 'TAKTIC_IMAGE_TAG', 'APP_ENVIRONMENT', 'POSTGRES_PASSWORD']) {
      assert.throws(() => resolveConfig('prod', { extraEnv: { [missing]: '' } }), undefined, `${missing} empty`);
    }
  });

  it('prod forwards every variable the development compose forwards, minus its test seams', () => {
    // A variable added to docker-compose.yml and forgotten here would silently
    // vanish on the next deploy. The exceptions are development-only by design.
    const devOnly = {
      api: ['CHOKIDAR_USEPOLLING', 'CHOKIDAR_INTERVAL', 'LEMON_SQUEEZY_API_BASE_URL'],
      web: ['NODE_ENV', 'NEXT_PUBLIC_API_URL'],
      admin: ['NODE_ENV', 'NEXT_PUBLIC_API_URL'],
    };
    const dev = resolveConfig('dev');
    const prod = resolveConfig('prod');
    for (const service of ['api', 'web', 'admin']) {
      const keys = (config) => Object.keys(config.services[service].environment ?? {});
      const missing = keys(dev).filter((key) => !keys(prod).includes(key) && !devOnly[service].includes(key));
      assert.deepEqual(missing, [], `${service}: forwarded by docker-compose.yml but not by docker-compose.prod.yml`);
    }
  });

  it('the local development stack is loopback-only without any override', () => {
    assert.deepEqual(auditDev(resolveConfig('dev')), []);
  });
});

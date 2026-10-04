// node --test scripts/ops/ops-scripts.test.mjs
//
// The deploy scripts themselves (deploy-preflight.sh, deploy-staging.sh,
// lib.sh), run for real against a fake `docker` on PATH. The fake answers
// from a JSON state file and logs every invocation, so each test can say both
// what the script concluded and what it asked Docker to do — in particular,
// that a preflight or a --check never asks for anything that changes state,
// and that the uploads ownership fix touches one volume and no other.
//
// No Docker daemon is involved: this runs anywhere bash, git and node exist.
// The real-Docker half (a root-owned volume actually chowned, a sentinel
// volume left alone) runs in CI's ops job against the throwaway stack.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaces = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require('fs');
const statePath = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');
const out = (text) => process.stdout.write(String(text ?? ''));
const after = (flag) => args[args.indexOf(flag) + 1];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const done = (code = 0) => process.exit(code);

if (args[0] === 'version') { out('28.0.0'); done(); }

if (args[0] === 'compose') {
  if (args[1] === 'version') { out('2.39.0'); done(); }
  if (args.includes('config')) { out(JSON.stringify(state.config)); done(); }
  if (args.includes('run')) {
    if (args.includes('dist/boot-config-check.js')) { out(state.boot.out); done(state.boot.code); }
    if (args.includes('migrate')) { const r = state.migrate[args[args.length - 1]]; out(r.out); done(r.code); }
  }
  done(99);
}

if (args[0] === 'image' && args[1] === 'inspect') {
  const image = (state.images || {})[args[args.length - 1]];
  if (!image) done(1);
  if (args.includes('-f')) {
    const template = after('-f');
    if (template.includes('revision')) out(image.revision);
    else if (template.includes('next-public-api-url')) out(image.apiUrl);
  }
  done();
}

if (args[0] === 'container' && args[1] === 'inspect') {
  const c = state.containers[args[args.length - 1]];
  if (!c) done(1);
  if (!args.includes('-f')) { out('[]'); done(); }
  const t = after('-f');
  if (t.includes('.State.Running')) out(c.running ? 'true' : 'false');
  else if (t.includes('.State.Health')) out(c.health || 'none');
  else if (t.includes('com.docker.compose.project')) out(c.project);
  else if (t.includes('/var/lib/postgresql/data')) out(c.dataVolume);
  else if (t.includes('/app/apps/api/uploads')) out(c.uploadsVolume);
  else if (t.includes('.HostIp')) out(c.hostIps || '');
  else if (t.includes('.Config.Env')) out((c.env || []).join('\n') + '\n');
  else if (t.includes('.Config.Image')) out(c.image);
  else if (t.includes('.Id')) out(c.id);
  done();
}

if (args[0] === 'exec') {
  const rest = args.filter((a) => a !== '-i');
  if (rest[2] === 'printenv') { out(state.pg[rest[3]]); done(); }
  if (rest[2] === 'pg_isready') done(0);
  if (rest[2] === 'psql') {
    const sql = after('-c');
    if (sql.includes('pg_database_size')) out('14000000');
    else if (sql.includes('count(*)')) out(String(state.pg.applied.length));
    else if (sql.includes('finished_at IS NULL')) out('');
    else if (sql.includes('migration_name')) out(state.pg.applied.join('\n'));
    done();
  }
  done(99);
}

if (args[0] === 'volume' && args[1] === 'inspect') done(state.volumes.includes(args[2]) ? 0 : 1);

if (args[0] === 'run') {
  const script = args.includes('-c') ? after('-c') : '';
  const mount = args.includes('-v') ? after('-v') : '';
  if (args.includes('CHOWN')) {
    const volume = mount.split(':')[0];
    state.chowned = (state.chowned || []).concat(volume);
    state.uploads.report = '0 0';
    save();
    out('files=' + state.uploads.files);
    done();
  }
  if (script.includes('foreign=')) { out(state.uploads.report); done(); }
  if (script.includes('find /u -type f | wc -l')) { out(state.uploads.files); done(); }
  if (script.includes('id -u')) { out(state.runtimeIds || '1000:1000'); done(); }
  if (args[args.length - 1] === 'migrations') { out(state.pg.applied.join('\n')); done(); }
  done(99);
}

done(99);
`;

const API_URL = 'https://api-staging.example.test';
const PLACEHOLDER_FINGERPRINT = 'placeholder-fingerprint-key-not-a-secret-0001';

/** What `docker compose config` resolves for the staging host. */
function stagingConfig(project = 'taktic-staging') {
  const image = (name) => `taktic-${name}:0000000000000000000000000000000000000000`;
  const hardened = { security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'] };
  const loopback = (target) => ({ host_ip: '127.0.0.1', target, published: String(target), protocol: 'tcp' });
  return {
    name: project,
    services: {
      postgres: { image: 'postgres:16.6-alpine' },
      migrate: { image: image('migrate'), ...hardened },
      api: {
        image: image('api'),
        ...hardened,
        ports: [loopback(3001)],
        environment: {
          NODE_ENV: 'production',
          APP_ENVIRONMENT: 'staging',
          DATABASE_URL: 'postgresql://placeholder',
          PROMOTION_FINGERPRINT_KEY: PLACEHOLDER_FINGERPRINT,
          PAYMENT_PROVIDER: 'lemon-squeezy-test',
          LEMON_SQUEEZY_API_KEY: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.placeholderNotARealCredential',
          LEMON_SQUEEZY_STORE_ID: '424242',
          LEMON_SQUEEZY_WEBHOOK_SECRET: 'placeholder-webhook-secret-not-real',
          LEMON_SQUEEZY_VARIANT_MAP: 'baslangic:111',
          API_PUBLIC_URL: API_URL,
          WEB_APP_URL: 'https://staging.example.test',
          WEB_ORIGIN: 'https://staging.example.test',
          ADMIN_ORIGIN: 'https://admin-staging.example.test',
          EMAIL_TRANSPORT: 'resend',
          RESEND_API_KEY: 're_placeholderNotARealKey',
          EMAIL_FROM: 'Taktick <noreply@notify.taktick.com.tr>',
          TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
          TURNSTILE_EXPECTED_HOSTNAMES: 'staging.example.test',
        },
        volumes: [{ type: 'volume', source: 'taktic-api-uploads', target: '/app/apps/api/uploads' }],
      },
      web: {
        image: image('web'),
        ...hardened,
        ports: [loopback(3000)],
        environment: { APP_ENVIRONMENT: 'staging', TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
      },
      admin: { image: image('admin'), ...hardened, ports: [loopback(3002)], environment: {} },
    },
  };
}

function stagingState({ project = 'taktic-staging', images = false, sha = '' } = {}) {
  const state = {
    config: stagingConfig(project),
    images: {},
    boot: { out: 'ok   payment-provider\nboot-config: OK\n', code: 0 },
    migrate: {
      status: { out: 'Database schema is up to date!', code: 0 },
      drift: { out: 'No difference detected.', code: 0 },
    },
    containers: {
      'taktic-postgres': {
        running: true,
        health: 'healthy',
        project: 'taktic-staging',
        dataVolume: 'taktic-staging_taktic-postgres-data',
        hostIps: '127.0.0.1 ',
        id: 'postgres-container-id',
      },
      'taktic-api': {
        running: true,
        project: 'taktic-staging',
        uploadsVolume: 'taktic-staging_taktic-api-uploads',
        env: ['NODE_ENV=development', 'APP_ENVIRONMENT=staging', 'DATABASE_URL=postgresql://placeholder', 'PATH=/usr/bin'],
        image: 'node:22-alpine',
        id: 'api-container-id',
      },
    },
    pg: { POSTGRES_USER: 'taktic_user', POSTGRES_DB: 'taktic', applied: ['20260101000000_init'] },
    volumes: ['taktic-staging_taktic-api-uploads', 'taktic-staging_taktic-postgres-data', 'unrelated_volume'],
    uploads: { report: '0 0', files: '0' },
  };
  if (images) {
    for (const target of ['api', 'web', 'admin', 'migrate']) {
      state.images[`taktic-${target}:${sha}`] = { revision: sha, apiUrl: API_URL };
    }
  }
  return state;
}

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=ops@test', '-c', 'user.name=ops-test', ...args], { cwd, encoding: 'utf8' }).trim();

/** A throwaway checkout holding this commit's scripts, a staging .env and the fake docker. */
function workspace({ env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'taktic-ops-test-'));
  workspaces.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(bin);
  cpSync(join(repoRoot, 'scripts/ops'), join(repo, 'scripts/ops'), { recursive: true });
  cpSync(join(repoRoot, 'docker-compose.prod.yml'), join(repo, 'docker-compose.prod.yml'));
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  const dotenv = { COMPOSE_PROJECT_NAME: 'taktic-staging', NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_WEB_URL: 'https://staging.example.test', ...env };
  writeFileSync(join(repo, '.env'), Object.entries(dotenv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const sha = git(repo, 'rev-parse', 'HEAD');
  return { dir, repo, bin, sha, statePath: join(dir, 'state.json'), logPath: join(dir, 'docker.log') };
}

function run(ws, state, script, args, extraEnv = {}) {
  writeFileSync(ws.statePath, JSON.stringify(state));
  writeFileSync(ws.logPath, '');
  const result = spawnSync('bash', [join(ws.repo, 'scripts/ops', script), ...args], {
    cwd: ws.repo,
    encoding: 'utf8',
    env: {
      PATH: `${ws.bin}:${process.env.PATH}`,
      HOME: ws.dir,
      TMPDIR: ws.dir,
      TAKTIC_BACKUP_DIR: join(ws.dir, 'backups', 'taktic'),
      FAKE_DOCKER_STATE: ws.statePath,
      FAKE_DOCKER_LOG: ws.logPath,
      ...extraEnv,
    },
  });
  const calls = readFileSync(ws.logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { code: result.status, stderr: result.stderr, stdout: result.stdout, calls, state: JSON.parse(readFileSync(ws.statePath, 'utf8')) };
}

/** Docker calls that change state. A preflight or a --check must make none. */
function mutatingCalls(calls) {
  return calls.filter((args) => {
    const text = args.join(' ');
    if (args[0] === 'compose') {
      if (args.includes('config') || args[1] === 'version') return false;
      // Throwaway one-off containers of the new images: --rm, --no-deps.
      if (args.includes('run') && args.includes('--rm') && args.includes('--no-deps')) return false;
      return true;
    }
    if (['stop', 'start', 'restart', 'rm', 'kill', 'build', 'create', 'pull', 'tag'].includes(args[0])) return true;
    if (args[0] === 'volume' && args[1] !== 'inspect') return true;
    if (args[0] === 'run') return !args.includes('--rm') || text.includes('CHOWN') || args.some((a) => /:\/u$/.test(a));
    return false;
  });
}

const failLines = (stderr) => stderr.split('\n').filter((line) => /\bFAIL\b/.test(line)).join('\n');

describe('deploy-preflight.sh: configuration fails before anything is stopped', () => {
  it('passes the staging contract with images built, and changes nothing', () => {
    const ws = workspace();
    const result = run(ws, stagingState({ images: true, sha: ws.sha }), 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /PASS PROMOTION_FINGERPRINT_KEY/);
    assert.match(result.stderr, /PASS test-payment contract/);
    assert.match(result.stderr, /ok   the new API accepts this configuration at boot/);
    assert.deepEqual(mutatingCalls(result.calls), []);
    const boot = result.calls.find((args) => args.includes('dist/boot-config-check.js'));
    assert.ok(boot.includes('--rm') && boot.includes('--no-deps'), 'the boot check runs in a throwaway container');
    assert.equal(existsSync(join(ws.dir, 'backups')), false, 'the preflight created the backup directory');
  });

  it('fails a missing PROMOTION_FINGERPRINT_KEY by name, without a value', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    delete state.config.services.api.environment.PROMOTION_FINGERPRINT_KEY;
    state.boot = {
      out: 'FAIL promotion-fingerprint: PROMOTION_FINGERPRINT_KEY is required (APP_ENVIRONMENT is "staging")\nboot-config: 1 check(s) refused\n',
      code: 1,
    };
    const result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /FAIL PROMOTION_FINGERPRINT_KEY: not set/);
    assert.match(failLines(result.stderr), /the new API would refuse to start/);
    assert.deepEqual(mutatingCalls(result.calls), []);
  });

  it('fails a short PROMOTION_FINGERPRINT_KEY and never prints it', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    const short = 'short-key-not-long-enough';
    state.config.services.api.environment.PROMOTION_FINGERPRINT_KEY = short;
    const result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /FAIL PROMOTION_FINGERPRINT_KEY: shorter than 32 characters/);
    assert.ok(!result.stderr.includes(short));
    assert.ok(!result.stderr.includes('placeholder-webhook-secret-not-real'));
  });

  it('fails a wrong COMPOSE_PROJECT_NAME twice over: the contract and the PostgreSQL owner', () => {
    const ws = workspace({ env: { COMPOSE_PROJECT_NAME: 'taktick' } });
    const result = run(ws, stagingState({ project: 'taktick', images: true, sha: ws.sha }), 'deploy-preflight.sh', [
      '--sha',
      ws.sha,
      '--skip-fetch',
    ]);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /FAIL COMPOSE_PROJECT_NAME: is not taktic-staging/);
    assert.match(failLines(result.stderr), /belongs to compose project 'taktic-staging', not 'taktick'/);
  });

  it('stops at once when COMPOSE_PROJECT_NAME is not set at all', () => {
    const ws = workspace({ env: { COMPOSE_PROJECT_NAME: '' } });
    const result = run(ws, stagingState(), 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /COMPOSE_PROJECT_NAME is not set/);
  });

  it('fails the sandbox provider when the host says production', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.config.services.api.environment.APP_ENVIRONMENT = 'production';
    state.config.services.web.environment.APP_ENVIRONMENT = 'production';
    const result = run(ws, state, 'deploy-preflight.sh', [
      '--sha', ws.sha, '--skip-fetch', '--environment', 'production', '--project', 'taktic-staging',
    ]);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /FAIL PAYMENT_PROVIDER: not allowed on production/);
  });

  it('fails a root-owned uploads volume without --allow-uploads-ownership-fix, and only warns with it', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.uploads.report = '3 0';

    let result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /3 entries not owned by 1000:1000.*--fix-uploads-ownership/);

    result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch', '--allow-uploads-ownership-fix']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /WARN 3 entries not owned by 1000:1000; deploy-staging.sh --fix-uploads-ownership/);
    assert.deepEqual(mutatingCalls(result.calls), [], 'the preflight itself never chowns');
    const inspected = result.calls.filter((args) => args[0] === 'run' && args.some((a) => a.endsWith(':/u:ro')));
    assert.ok(inspected.length > 0);
    for (const args of inspected) {
      assert.ok(args.includes('taktic-staging_taktic-api-uploads:/u:ro'), `inspected another volume: ${args.join(' ')}`);
    }
  });

  it('fails an uploads volume holding links or special files', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.uploads.report = '0 1';
    const result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch', '--allow-uploads-ownership-fix']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /1 link\(s\) or special file\(s\)/);
  });

  it('reports the image-dependent checks as NOT RUN (exit 3) when images are allowed to be missing', () => {
    const ws = workspace();
    const result = run(ws, stagingState(), 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch', '--allow-missing-images']);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /NOT RUN the API image is not built/);
    assert.match(result.stderr, /NOT RUN the migrate image is not built/);
    assert.match(result.stderr, /INCOMPLETE/);
    assert.deepEqual(mutatingCalls(result.calls), []);
  });

  it('still fails a broken contract when images are allowed to be missing', () => {
    const ws = workspace();
    const state = stagingState();
    delete state.config.services.api.environment.PROMOTION_FINGERPRINT_KEY;
    const result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch', '--allow-missing-images']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /PROMOTION_FINGERPRINT_KEY: not set/);
  });
});

describe('deploy-staging.sh --check', () => {
  it('fetches nothing, builds nothing, writes nothing and moves nothing', () => {
    const ws = workspace();
    const head = git(ws.repo, 'rev-parse', 'HEAD');
    // No `origin` remote exists in this checkout: a fetch would fail the run.
    const result = run(ws, stagingState(), 'deploy-staging.sh', ['--sha', ws.sha, '--check']);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /--check: no failure, but checks that need the images were NOT RUN; nothing was changed/);
    assert.deepEqual(mutatingCalls(result.calls), []);
    assert.equal(result.calls.some((args) => args.includes('build')), false);
    assert.equal(existsSync(join(ws.dir, 'backups')), false, '--check created the backup or log directory');
    assert.equal(git(ws.repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(ws.repo, 'status', '--porcelain'), '');
  });

  it('exits 0 once the images exist, and 1 on a broken contract', () => {
    const ws = workspace();
    let result = run(ws, stagingState({ images: true, sha: ws.sha }), 'deploy-staging.sh', ['--sha', ws.sha, '--check']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /--check: preflight passed; nothing was changed/);

    const state = stagingState({ images: true, sha: ws.sha });
    state.config.services.api.environment.NODE_ENV = 'development';
    result = run(ws, state, 'deploy-staging.sh', ['--sha', ws.sha, '--check']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /NODE_ENV \(api\): is not production/);
    assert.deepEqual(mutatingCalls(result.calls), []);
  });
});

describe('the uploads ownership fix', () => {
  function libRun(ws, state, snippet) {
    writeFileSync(join(ws.dir, 'snippet.sh'), `source "${join(ws.repo, 'scripts/ops/lib.sh')}"\n${snippet}\n`);
    return run(ws, state, '../../../snippet.sh', []);
  }

  it('changes the one volume it is given, to the image runtime uid:gid, and nothing else', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.uploads = { report: '3 0', files: '2' };
    state.runtimeIds = '1000:1000';
    const result = libRun(
      ws,
      state,
      `uploads_ownership_fix taktic-staging_taktic-api-uploads "$(image_runtime_ids taktic-api:${ws.sha})"`,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'files=2');
    assert.deepEqual(result.state.chowned, ['taktic-staging_taktic-api-uploads']);
    const fix = result.calls.find((args) => args.includes('CHOWN'));
    assert.deepEqual(
      fix.filter((a, i) => fix[i - 1] === '-v'),
      ['taktic-staging_taktic-api-uploads:/u'],
      'exactly one volume mounted',
    );
    assert.ok(fix.includes('OWNER_UID=1000') && fix.includes('OWNER_GID=1000'));
    assert.ok(fix.includes('--network') && fix.includes('none') && fix.includes('--rm'));
    assert.equal(result.calls.filter((args) => args.includes('CHOWN')).length, 1);
  });

  it('runs step 1b on the API container\'s mounted volume, before the API is stopped', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.uploads.report = '3 0';
    const result = run(ws, state, 'deploy-staging.sh', ['--sha', ws.sha, '--dry-run', '--skip-build', '--fix-uploads-ownership'], {
      // The dry run fetches like a deploy; give it a remote that answers.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.url',
      GIT_CONFIG_VALUE_0: ws.repo,
    });
    assert.equal(result.code, 0, result.stderr);
    const fixAt = result.stderr.indexOf('[dry-run] uploads_ownership_fix taktic-staging_taktic-api-uploads 1000:1000');
    const stopAt = result.stderr.indexOf('2. Stopping');
    assert.ok(fixAt > 0, 'step 1b did not name the mounted volume');
    assert.ok(fixAt < stopAt, 'the ownership fix must come before the API is stopped');
    assert.equal(result.stderr.includes('chown -R'), false, 'the old step-8 chown is gone');
  });

  it('refuses when the API container mounts another volume than the prod file would', () => {
    const ws = workspace();
    const state = stagingState({ images: true, sha: ws.sha });
    state.containers['taktic-api'].uploadsVolume = 'unrelated_volume';
    const result = run(ws, state, 'deploy-preflight.sh', ['--sha', ws.sha, '--skip-fetch', '--allow-uploads-ownership-fix']);
    assert.equal(result.code, 1);
    assert.match(failLines(result.stderr), /taktic-api uses 'unrelated_volume'/);
    assert.equal(result.calls.some((args) => args.some((a) => a.startsWith('unrelated_volume:'))), false);
  });
});

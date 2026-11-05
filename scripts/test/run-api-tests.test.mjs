// The runner against stand-ins for `docker` and `pnpm`: every path that must stop
// or clean up, without a container. Real runs are recorded in the spec document.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LABELS, KIND, SERVER_SETTINGS } from './api-test-plan.mjs';

const runner = fileURLToPath(new URL('./run-api-tests.mjs', import.meta.url));

const DOCKER_STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), net = require('net'), { spawn } = require('child_process');
const dir = path.dirname(fs.realpathSync(__filename));
const stateFile = path.join(dir, 'containers.json');
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const out = (t) => process.stdout.write(t + '\\n');
const fail = (t) => { process.stderr.write(t + '\\n'); process.exit(1); };
const cmd = args[0];
if (cmd === 'version') { if (cfg.down) fail('Cannot connect to the Docker daemon'); out('29.0.0'); }
else if (cmd === 'ps') {
  const [k, v] = args[args.indexOf('--filter') + 1].slice('label='.length).split('=');
  for (const c of state()) if (c.labels[k] === v) out(c.id);
}
else if (cmd === 'inspect') {
  const f = args.indexOf('-f');
  if (f !== -1) { const c = state().find((x) => x.id === args[f + 2]); if (cfg.dies) { out('false'); } else out(c ? String(c.running) : 'false'); }
  else out(JSON.stringify(args.slice(1).map((id) => { const c = state().find((x) => x.id === id); return { Id: c.id, Name: '/' + c.id, Config: { Labels: c.labels }, State: { Running: c.running } }; })));
}
else if (cmd === 'run') {
  if (cfg.runFails) fail('image not found');
  const labels = {};
  args.forEach((a, i) => { if (a === '--label') { const at = args[i + 1].indexOf('='); labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1); } });
  const server = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{require('fs').writeFileSync(process.argv[1],String(s.address().port))})", path.join(dir, 'port')], { detached: true, stdio: 'ignore' });
  server.unref();
  while (!fs.existsSync(path.join(dir, 'port'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  let port = '';
  while (!port) port = fs.readFileSync(path.join(dir, 'port'), 'utf8');
  save([...state(), { id: 'own0000', labels, running: true, serverPid: server.pid, port }]);
  fs.writeFileSync(path.join(dir, 'run-env.json'), JSON.stringify({ password: process.env.POSTGRES_PASSWORD }));
  out('own0000');
}
else if (cmd === 'port') { const c = state().find((x) => x.id === args[1]); out(cfg.published ?? '127.0.0.1:' + c.port); }
else if (cmd === 'exec') {
  const text = args.join(' ');
  if (text.includes('pg_isready')) process.exit(0);
  if (text.includes('/proc/mounts')) out(cfg.mount ?? 'tmpfs rw,size=2097152k');
  else if (text.includes('pg_settings')) out(${JSON.stringify(Object.entries(SERVER_SETTINGS).map(([k, v]) => `${k}=${v.replace(/MB|s$/, '')}`).join('\n'))});
  else if (text.includes('pg_database')) { out('postgres\\ntaktic'); for (let i = 1; i <= 2; i++) out('taktic_api_shard_' + i + '_test'); }
  else if (text.includes('application_name')) out(cfg.activity ?? '');
  else if (text.includes('pg_stat_activity')) out(String((cfg.clients ?? {})[args[1]] ?? 0));
  else if (text.includes('pg_stat_database')) out(String(cfg.baseWrites ?? 0));
  else if (args.includes('df')) out('Filesystem 1K-blocks Used Available Use% Mounted\\ntmpfs 2097152 10240 2086912 1% /var/lib/postgresql/data');
}
else if (cmd === 'stats') out('12MiB / 1GiB');
else if (cmd === 'logs') out('');
else if (cmd === 'rm') {
  const ids = args.slice(2);
  for (const c of state()) if (ids.includes(c.id) && c.serverPid) { try { process.kill(-c.serverPid, 'SIGKILL'); } catch {} }
  save(state().filter((c) => !ids.includes(c.id)));
}
`;

const PNPM_STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = path.dirname(fs.realpathSync(__filename));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const slug = process.env.TEST_DATABASE_SLUG;
fs.writeFileSync(path.join(dir, 'env-' + slug + '.json'), JSON.stringify({ env: process.env, args }));
if (cfg.hang) {
  fs.writeFileSync(path.join(dir, 'pid-' + slug), String(process.pid));
  process.on('SIGTERM', () => { if (!cfg.ignoreTerm) process.exit(1); });
  setInterval(() => {}, 1000);
  return;
}
console.log('[api-test] database "taktic_' + slug + '_test" (checkout ' + slug + ', created, reset: ' + process.env.TEST_DB_RESET + ')');
if (cfg.noReport) process.exit(1);
let files = args.filter((a) => a.startsWith('test/'));
if (cfg.dropFile) files = files.filter((f) => f !== cfg.dropFile);
if (cfg.hold) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cfg.hold);
const failing = cfg.failFile;
const report = { startTime: 1000, testResults: files.map((f, i) => ({
  name: '/x/apps/api/' + f, status: f === failing ? 'failed' : 'passed', startTime: 1000 + i, endTime: 1001 + i,
  assertionResults: [{ status: f === failing ? 'failed' : 'passed', fullName: 'stub ' + f, failureMessages: f === failing ? ['expected 200, got 401'] : [] }],
})) };
const out = args.find((a) => a.startsWith('--outputFile.json=')).split('=')[1];
fs.writeFileSync(out, JSON.stringify(report));
if (cfg.unhandled) console.log('⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯\\nConflictException: nope');
process.exit(files.includes(failing) || cfg.unhandled ? 1 : 0);
`;

let dir;
const config = (value) => writeFileSync(join(dir, 'config.json'), JSON.stringify(value));
const containers = () => JSON.parse(readFileSync(join(dir, 'containers.json'), 'utf8'));
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pnpmRan = () => readdirSync(dir).some((f) => f.startsWith('env-'));

function start(args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [runner, '--shards=2', `--report-dir=${join(dir, 'reports')}`, ...args], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TEST_DATABASE_URL: 'postgresql://x:y@localhost:5433/taktic_test',
      TEST_DB_RESET: 'truncate',
      DATABASE_URL: 'postgresql://x:y@localhost:5433/taktic',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, get output() { return output; } })));
  return { child, done };
}

const run = (args) => start(args).done;

function summary() {
  const root = join(dir, 'reports');
  const [only] = readdirSync(root);
  return JSON.parse(readFileSync(join(root, only, 'summary.json'), 'utf8'));
}

async function until(check) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail('timed out waiting for the runner');
}

// A zombie has already exited. Once the runner is gone, only PID 1 can reap what
// it killed, at its own pace, and signal 0 still reaches the process until then.
const alive = (pid) => {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && !r.stdout.trim().startsWith('Z');
};

const labelled = (id, overrides = {}) => ({
  id,
  running: true,
  labels: { [LABELS.kind]: KIND, [LABELS.run]: id, [LABELS.pid]: '99999', [LABELS.pidStart]: 'long ago', [LABELS.host]: hostname(), ...overrides },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-api-tests-'));
  writeFileSync(join(dir, 'docker'), DOCKER_STUB);
  writeFileSync(join(dir, 'pnpm'), PNPM_STUB);
  chmodSync(join(dir, 'docker'), 0o755);
  chmodSync(join(dir, 'pnpm'), 0o755);
  writeFileSync(join(dir, 'containers.json'), '[]');
  writeFileSync(join(dir, 'calls.log'), '');
  config({});
});

afterEach(() => {
  for (const c of containers()) if (c.serverPid) try { process.kill(-c.serverPid, 'SIGKILL'); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe('a clean run', () => {
  it('passes, on a loopback URL, with an environment the shell can not redirect, and leaves nothing', async () => {
    const { code, output } = await run();
    assert.equal(code, 0, output);
    assert.equal(summary().passed, true);
    assert.equal(containers().length, 0);
    assert.match(output, /API tests PASSED/);

    const seen = ['api_shard_1', 'api_shard_2'].map((slug) => JSON.parse(readFileSync(join(dir, `env-${slug}.json`), 'utf8')));
    for (const { env } of seen) {
      assert.equal(env.TEST_DATABASE_URL, undefined);
      assert.equal(env.TEST_DB_RESET, 'delete');
      assert.match(env.DATABASE_URL, /@127\.0\.0\.1:\d+\/taktic\?.*application_name=api_shard_\d/);
      assert.doesNotMatch(env.DATABASE_URL, /:5433\//);
    }
    assert.equal(new Set(seen.map(({ args }) => args.filter((a) => a.startsWith('test/')).join())).size, 2);
    assert.ok(!seen.some(({ args }) => args.some((a) => a.startsWith('--') && /retry|timeout/i.test(a))));
  });

  it('does not put the password on a command line or in a log', async () => {
    const { output } = await run();
    const { password } = JSON.parse(readFileSync(join(dir, 'run-env.json'), 'utf8'));
    assert.match(password, /^[0-9a-f]{32}$/);
    assert.ok(!readFileSync(join(dir, 'calls.log'), 'utf8').includes(password));
    assert.ok(!output.includes(password));
  });

  it('never addresses the development stack', async () => {
    await run();
    const text = readFileSync(join(dir, 'calls.log'), 'utf8');
    assert.ok(!text.includes('taktic-postgres'));
    assert.ok(!text.includes('5433'));
    const removed = calls().filter((c) => c[0] === 'rm').flatMap((c) => c.slice(2));
    assert.deepEqual([...new Set(removed)], ['own0000']);
  });
});

describe('what makes a run red', () => {
  it('a failing test: named in the report, and the container still goes', async () => {
    config({ failFile: 'test/boot-config.spec.ts' });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /API tests FAILED/);
    assert.match(output, /test\/boot-config\.spec\.ts › stub/);
    assert.match(output, /expected 200, got 401/);
    assert.equal(containers().length, 0);
  });

  it('an error outside any test: every test passed, and the reason is still shown', async () => {
    config({ unhandled: true });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /outside any test: ConflictException: nope/);
    assert.match(output, /shard 1 exited 1; its log is/);
  });

  it('a file that ran nowhere', async () => {
    config({ dropFile: 'test/boot-config.spec.ts' });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /test\/boot-config\.spec\.ts ran in no shard/);
  });

  it('a shard with no report', async () => {
    config({ noReport: true });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /shard 1\/2 has no report/);
    assert.equal(containers().length, 0);
  });

  it('a row written to the base database', async () => {
    config({ baseWrites: 3 });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /rows were written to the base database/);
  });
});

describe('a connection in the wrong database', () => {
  it('turns the run red', async () => {
    config({ activity: 'api_shard_1|taktic_api_shard_2_test', hold: 6000 });
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /api_shard_1 connected to taktic_api_shard_2_test/);
  });
});

describe('stopping before any test starts', () => {
  const stops = {
    'Docker is down': [{ down: true }, /Docker is not reachable/],
    'the container does not start': [{ runFails: true }, /did not start: image not found/],
    'it is published beyond loopback': [{ published: '0.0.0.0:55001' }, /not on 127\.0\.0\.1 only/],
    'it landed on the development port': [{ published: '127.0.0.1:5433' }, /development/],
    'its data is on a disk': [{ mount: 'ext4 rw' }, /not a tmpfs/],
    'it dies while starting': [{ dies: true }, /stopped while starting/],
  };
  for (const [name, [cfg, message]] of Object.entries(stops)) {
    it(`stops when ${name}`, async () => {
      config(cfg);
      const { code, output } = await run();
      assert.equal(code, 1);
      assert.match(output, message);
      assert.equal(pnpmRan(), false);
      assert.equal(containers().length, 0);
    });
  }
});

describe('signals', () => {
  for (const [signal, exit] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    it(`${signal}: stops the shards, removes its container, leaves another run's`, async () => {
      config({ hang: true });
      const other = labelled('other00', { [LABELS.pid]: String(process.pid) });
      other.labels[LABELS.pidStart] = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
      writeFileSync(join(dir, 'containers.json'), JSON.stringify([other]));

      const { child, done } = start();
      await until(() => existsSync(join(dir, 'pid-api_shard_1')) && existsSync(join(dir, 'pid-api_shard_2')));
      const pids = ['api_shard_1', 'api_shard_2'].map((s) => Number(readFileSync(join(dir, `pid-${s}`), 'utf8')));
      child.kill(signal);
      const { code } = await done;

      assert.equal(code, exit);
      assert.deepEqual(pids.map(alive), [false, false]);
      assert.deepEqual(containers().map((c) => c.id), ['other00']);
    });
  }

  it('reaches a shard that ignores SIGTERM', async () => {
    config({ hang: true, ignoreTerm: true });
    const { child, done } = start();
    await until(() => existsSync(join(dir, 'pid-api_shard_1')) && existsSync(join(dir, 'pid-api_shard_2')));
    const pid = Number(readFileSync(join(dir, 'pid-api_shard_1'), 'utf8'));
    child.kill('SIGINT');
    const { code } = await done;
    assert.equal(code, 130);
    assert.equal(alive(pid), false);
    assert.equal(containers().length, 0);
  });
});

describe('leftovers of earlier runs', () => {
  it('reads a live owner the same in another time zone', async () => {
    const live = labelled('live000', { [LABELS.pid]: String(process.pid) });
    live.labels[LABELS.pidStart] = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
    writeFileSync(join(dir, 'containers.json'), JSON.stringify([live]));
    const { child, done } = start([], { TZ: 'Asia/Tokyo' });
    assert.equal((await done).code, 0);
    assert.ok(child.pid);
    assert.deepEqual(containers().map((c) => c.id), ['live000']);
  });

  it('keeps every container when `ps` can not answer, and then stops', async () => {
    writeFileSync(join(dir, 'ps'), '#!/bin/sh\nexit 2\n');
    chmodSync(join(dir, 'ps'), 0o755);
    writeFileSync(join(dir, 'containers.json'), JSON.stringify([labelled('dead000')]));
    const { code, output } = await run();
    assert.equal(code, 1);
    assert.match(output, /could not say when this process started/);
    assert.deepEqual(containers().map((c) => c.id), ['dead000']);
    assert.equal(pnpmRan(), false);
  });

  it('removes only a container whose run ended and that nothing uses', async () => {
    const live = labelled('live000', { [LABELS.pid]: String(process.pid) });
    live.labels[LABELS.pidStart] = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
    writeFileSync(join(dir, 'containers.json'), JSON.stringify([
      labelled('dead000'),
      labelled('stopped', {}),
      labelled('used000'),
      labelled('remote0', { [LABELS.host]: 'another-machine' }),
      live,
      { id: 'taktic-postgres', running: true, labels: {} },
    ].map((c) => (c.id === 'stopped' ? { ...c, running: false } : c))));
    config({ clients: { used000: 2 } });

    const { code, output } = await run();
    assert.equal(code, 0, output);
    assert.deepEqual(containers().map((c) => c.id).sort(), ['live000', 'remote0', 'taktic-postgres', 'used000']);
  });
});

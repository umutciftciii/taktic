import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DURATIONS_PROJECT, LABELS, KIND, RESERVED_PORT, buildApiPlan, checkMount, checkPlanned, checkSettings,
  databaseCrossings, databaseUrl, parseArgs, parsePublishedPort, reportFailures, reportFileMs, shardEnv, staleVerdict, unhandledErrors,
} from './api-test-plan.mjs';

const durations = (seconds) => JSON.stringify({ version: 1, projects: { [DURATIONS_PROJECT]: seconds } });

describe('parseArgs', () => {
  it('defaults to four shards', () => assert.equal(parseArgs([]).shards, 4));
  it('takes both spellings, and the -- pnpm can pass along', () => {
    assert.equal(parseArgs(['--shards=2']).shards, 2);
    assert.equal(parseArgs(['--', '--shards', '3']).shards, 3);
  });
  for (const bad of ['0', '9', '2.5', 'x', '']) {
    it(`refuses --shards=${bad}`, () => assert.throws(() => parseArgs([`--shards=${bad}`])));
  }
  it('refuses what it does not know, so a retry or timeout flag can not look accepted', () => {
    assert.throws(() => parseArgs(['--retry=2']), /unknown option/);
  });
});

describe('buildApiPlan', () => {
  const files = ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts', 'test/d.spec.ts', 'test/e.spec.ts'];

  it('puts every file in exactly one shard', () => {
    const plan = buildApiPlan(files, durations({ 'test/a.spec.ts': 10 }), 2);
    assert.deepEqual(plan.shards.flatMap((s) => s.files).sort(), files);
  });
  it('is deterministic whatever order the files were found in', () => {
    const text = durations({ 'test/a.spec.ts': 9, 'test/b.spec.ts': 9, 'test/c.spec.ts': 1 });
    assert.deepEqual(buildApiPlan(files, text, 2), buildApiPlan([...files].reverse(), text, 2));
  });
  it('balances by history', () => {
    const plan = buildApiPlan(files, durations({ 'test/a.spec.ts': 100, 'test/b.spec.ts': 1, 'test/c.spec.ts': 1, 'test/d.spec.ts': 1, 'test/e.spec.ts': 1 }), 2);
    assert.deepEqual(plan.shards.map((s) => s.files.length).sort(), [1, 4]);
  });
  it('estimates a file with no history and says so', () => {
    const plan = buildApiPlan(files, durations({ 'test/a.spec.ts': 5 }), 2);
    assert.deepEqual(plan.estimated, files.slice(1));
    assert.equal(plan.fallback, null);
  });
  it('falls back to file counts on a missing or broken history', () => {
    assert.match(buildApiPlan(files, undefined, 2).fallback, /missing/);
    assert.match(buildApiPlan(files, '{', 2).fallback, /not JSON/);
    assert.deepEqual(buildApiPlan(files, '{', 2).shards.map((s) => s.files.length), [3, 2]);
  });
  it('refuses a shard with nothing to run', () => {
    assert.throws(() => buildApiPlan(['test/a.spec.ts'], undefined, 2), /no files/);
  });
});

describe('shardEnv', () => {
  const parent = {
    PATH: '/bin', HOME: '/home', TEST_DATABASE_URL: 'postgresql://x@localhost:5433/taktic_test', TEST_DB_RESET: 'truncate',
    TEST_DATABASE_SLUG: 'other', DATABASE_URL: 'postgresql://x@localhost:5433/taktic', RESEND_API_KEY: 'k',
  };
  const env = shardEnv(parent, { databaseUrl: 'postgresql://u:p@127.0.0.1:1234/taktic', index: 3 });

  it('keeps the toolchain', () => assert.equal(env.PATH, '/bin'));
  it('drops what could redirect the suite', () => {
    assert.equal(env.TEST_DATABASE_URL, undefined);
    assert.equal(env.RESEND_API_KEY, undefined);
  });
  it('sets its own database, slug and reset', () => {
    assert.equal(env.DATABASE_URL, 'postgresql://u:p@127.0.0.1:1234/taktic');
    assert.equal(env.TEST_DATABASE_SLUG, 'api_shard_3');
    assert.equal(env.TEST_DB_RESET, 'delete');
  });
});

describe('published port', () => {
  it('accepts a single loopback address', () => assert.equal(parsePublishedPort('127.0.0.1:55001\n'), 55001));
  for (const bad of ['0.0.0.0:55001', '[::]:55001', '127.0.0.1:55001\n[::1]:55001', '']) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.throws(() => parsePublishedPort(bad)));
  }
  it('refuses the development port, in both places', () => {
    assert.throws(() => parsePublishedPort(`127.0.0.1:${RESERVED_PORT}`), /development/);
    assert.throws(() => databaseUrl(RESERVED_PORT, 'p', 1), /development/);
  });
});

describe('databaseCrossings', () => {
  it('accepts a shard in its own, its scratch and the maintenance database', () => {
    assert.deepEqual(databaseCrossings(['api_shard_2|taktic_api_shard_2_test', 'api_shard_2|taktic_api_shard_2_m1_test', 'api_shard_2|postgres', '|postgres', 'psql|taktic']), []);
  });
  it('names a shard in another shard\'s or the base database', () => {
    assert.deepEqual(databaseCrossings(['api_shard_1|taktic_api_shard_2_test', 'api_shard_1|taktic']), [
      'api_shard_1 connected to taktic_api_shard_2_test',
      'api_shard_1 connected to taktic',
    ]);
  });
});

describe('container checks', () => {
  it('accepts the tmpfs it asked for', () => assert.deepEqual(checkMount('tmpfs rw,nosuid,size=2097152k,inode64\n'), []));
  it('refuses a disk, a wrong size, nothing', () => {
    assert.equal(checkMount('ext4 rw').length, 1);
    assert.equal(checkMount('tmpfs rw,size=4194304k').length, 1);
    assert.equal(checkMount('').length, 1);
  });
  const good = 'fsync=off\nsynchronous_commit=off\nfull_page_writes=off\nwal_level=minimal\nmax_wal_senders=0\nmax_wal_size=256\ncheckpoint_timeout=30\nmax_connections=200\n';
  it('accepts the settings it asked for', () => assert.deepEqual(checkSettings(good), []));
  it('names a setting that did not take', () => {
    assert.match(checkSettings(good.replace('fsync=off', 'fsync=on'))[0], /fsync is on/);
    assert.match(checkSettings(good.replace('wal_level=minimal\n', ''))[0], /wal_level is unset/);
  });
});

describe('staleVerdict', () => {
  const labels = { [LABELS.kind]: KIND, [LABELS.run]: 'r', [LABELS.pid]: '42', [LABELS.pidStart]: 'then', [LABELS.host]: 'here' };
  const ended = { labels, running: true, hostname: 'here', ownerStarted: null, clientBackends: [0, 0] };

  it('removes a container whose run has ended and nothing uses', () => assert.equal(staleVerdict(ended).remove, true));
  it('treats a reused pid as an ended run', () => assert.equal(staleVerdict({ ...ended, ownerStarted: 'later' }).remove, true));
  it('removes a stopped container without asking it anything', () => {
    assert.equal(staleVerdict({ ...ended, running: false, clientBackends: [] }).remove, true);
  });

  const kept = {
    'a live owner': { ownerStarted: 'then' },
    'an owner it could not ask about': { ownerStarted: undefined },
    'a client in either sample': { clientBackends: [0, 1] },
    'connections it could not count': { clientBackends: null },
    'another machine': { hostname: 'elsewhere' },
    'another kind of container': { labels: { ...labels, [LABELS.kind]: 'something' } },
    'a missing label': { labels: { [LABELS.kind]: KIND } },
    'no labels at all': { labels: {} },
  };
  for (const [name, change] of Object.entries(kept)) {
    it(`keeps it on ${name}`, () => assert.equal(staleVerdict({ ...ended, ...change }).remove, false));
  }
});

describe('reports', () => {
  const report = {
    startTime: 1000,
    testResults: [
      { name: '/x/apps/api/test/b.spec.ts', status: 'passed', startTime: 4000, endTime: 7000, assertionResults: [{ status: 'passed' }] },
      { name: '/x/apps/api/test/a.spec.ts', status: 'failed', startTime: 1500, endTime: 3000, assertionResults: [{ status: 'failed', fullName: 'a fails', failureMessages: ['AssertionError: 401\n  at x'] }] },
      { name: '/x/apps/api/test/c.spec.ts', status: 'failed', message: 'Cannot find module\nstack', assertionResults: [] },
    ],
  };

  it('counts what a file cost from where the previous one ended, boot included', () => {
    const ms = reportFileMs({ startTime: 1000, testResults: report.testResults.slice(0, 2) });
    assert.deepEqual([...ms], [['test/a.spec.ts', 2000], ['test/b.spec.ts', 4000]]);
  });
  it('lists a failed test, and a file that never reached its tests', () => {
    assert.deepEqual(reportFailures(2, report).map((f) => [f.shard, f.file, f.test, f.message]), [
      [2, 'test/a.spec.ts', 'a fails', 'AssertionError: 401'],
      [2, 'test/c.spec.ts', null, 'Cannot find module'],
    ]);
  });
  it('finds an error outside any test in the log', () => {
    const log = ' ✓ test/a.spec.ts\n⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯\nConflictException: nope\n ❯ x\nThis error originated in "test/a.spec.ts" test file. It does\n';
    assert.deepEqual(unhandledErrors(log), ['ConflictException: nope', 'This error originated in "test/a.spec.ts" test file. It does']);
    assert.deepEqual(unhandledErrors(' ✓ test/a.spec.ts\n'), []);
  });
  it('compares what ran with what was planned', () => {
    const plan = { shards: [{ index: 1, files: ['test/a.spec.ts', 'test/z.spec.ts'] }] };
    const problems = checkPlanned(plan, new Map([[1, report]]));
    assert.ok(problems.some((p) => p.startsWith('test/z.spec.ts is planned')));
    assert.ok(problems.some((p) => p.startsWith('test/b.spec.ts ran in shard 1')));
  });
});

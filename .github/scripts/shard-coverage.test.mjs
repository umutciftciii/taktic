// node --test .github/scripts/shard-coverage.test.mjs
//
// One complete distribution that passes, then every way a sharded run can
// test less than the whole — each must be reported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiSpecFiles, checkPlaywright, checkVitest, playwrightTests } from './shard-coverage.mjs';

// ── Vitest ──────────────────────────────────────────────────────────────────

const FILES = ['test/a.spec.ts', 'test/b.spec.ts', 'test/c.spec.ts', 'test/d.spec.ts', 'test/e.spec.ts'];

const vitestFile = (path, statuses = ['passed']) => ({
  name: `/home/runner/work/taktic/taktic/apps/api/${path}`,
  status: statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
  endTime: 5_000,
  assertionResults: statuses.map((status, i) => ({ status, fullName: `case ${i}` })),
});

function vitestReports(layout = [[FILES[0], FILES[1]], [FILES[2], FILES[3]], [FILES[4]]]) {
  return new Map(layout.map((files, i) => [i + 1, { startTime: 1_000, testResults: files.map((f) => vitestFile(f)) }]));
}

const problemsOf = (r) => r.problems.join('\n');

test('vitest: every file in exactly one shard, all passed', () => {
  const r = checkVitest(FILES, vitestReports(), 3);
  assert.deepEqual(r.problems, []);
  assert.equal(r.tests, 5);
  assert.deepEqual(r.shards.map((s) => s.files), [2, 2, 1]);
  assert.equal(r.shards[0].seconds, 4);
});

test('vitest: a shard with no report fails', () => {
  const reports = vitestReports();
  reports.delete(2);
  const r = checkVitest(FILES, reports, 3);
  assert.match(problemsOf(r), /shard 2\/3 has no report/);
  assert.match(problemsOf(r), /test\/c\.spec\.ts ran in no shard/);
});

test('vitest: a shard the layout declares but the run never had fails', () => {
  assert.match(problemsOf(checkVitest(FILES, vitestReports(), 4)), /shard 4\/4 has no report/);
});

test('vitest: an empty shard fails', () => {
  const r = checkVitest(FILES, vitestReports([[...FILES], [], []]), 3);
  assert.match(problemsOf(r), /shard 2\/3 ran no files/);
});

test('vitest: a file run by two shards fails', () => {
  const r = checkVitest(FILES, vitestReports([[FILES[0], FILES[1]], [FILES[1], FILES[2], FILES[3]], [FILES[4]]]), 3);
  assert.match(problemsOf(r), /test\/b\.spec\.ts ran in shards 1, 2/);
});

test('vitest: a file no shard ran fails', () => {
  const r = checkVitest(FILES, vitestReports([[FILES[0]], [FILES[2], FILES[3]], [FILES[4]]]), 3);
  assert.match(problemsOf(r), /test\/b\.spec\.ts ran in no shard/);
});

test('vitest: a file outside the suite fails', () => {
  const r = checkVitest(FILES.slice(1), vitestReports(), 3);
  assert.match(problemsOf(r), /test\/a\.spec\.ts ran but is not one of the suite's files/);
});

for (const status of ['failed', 'skipped', 'pending', 'todo']) {
  test(`vitest: a ${status} test fails`, () => {
    const reports = vitestReports();
    reports.get(1).testResults[0] = vitestFile(FILES[0], ['passed', status]);
    assert.match(problemsOf(checkVitest(FILES, reports, 3)), new RegExp(`case 1 \\(shard 1\\) is ${status}`));
  });
}

test('vitest: a file that reported no tests fails', () => {
  const reports = vitestReports();
  reports.get(1).testResults[0] = vitestFile(FILES[0], []);
  assert.match(problemsOf(checkVitest(FILES, reports, 3)), /a\.spec\.ts \(shard 1\) reported no tests/);
});

test('vitest: a file that failed to load fails', () => {
  const reports = vitestReports();
  Object.assign(reports.get(1).testResults[0], { status: 'failed', message: 'boom' });
  assert.match(problemsOf(checkVitest(FILES, reports, 3)), /a\.spec\.ts \(shard 1\) is failed: boom/);
});

test('vitest: the API suite on disk is the one Vitest includes', () => {
  const files = apiSpecFiles();
  assert.ok(files.length > 200, `only ${files.length} API spec files found`);
  assert.ok(files.every((f) => /^test\/.+\.spec\.ts$/.test(f)));
});

// ── Playwright ──────────────────────────────────────────────────────────────

const spec = (file, line, title, status = 'expected', project = 'chromium') => ({
  title,
  file,
  line,
  column: 7,
  tests: [{ projectName: project, status }],
});

/** A Playwright report holding `specs` grouped as file › describe › test. */
function pwReport(specs, duration = 60_000) {
  const files = [...new Set(specs.map((s) => s.file))];
  return {
    stats: { duration },
    suites: files.map((file) => ({
      title: file,
      file,
      specs: specs.filter((s) => s.file === file && s.line < 10),
      suites: [{ title: 'flow', file, specs: specs.filter((s) => s.file === file && s.line >= 10), suites: [] }],
    })),
  };
}

const ALL = [
  spec('a.spec.ts', 3, 'top level'),
  spec('a.spec.ts', 12, 'one'),
  spec('b.spec.ts', 12, 'two'),
  spec('c.spec.ts', 14, 'three'),
];
const LISTED = pwReport(ALL.map((s) => ({ ...s, tests: [{ ...s.tests[0], status: 'skipped' }] })));

test('playwright: tests are keyed by project, place and describe path', () => {
  assert.deepEqual(
    playwrightTests(pwReport(ALL)).map((t) => t.key),
    [
      '[chromium] a.spec.ts:3:7 › top level',
      '[chromium] a.spec.ts:12:7 › flow › one',
      '[chromium] b.spec.ts:12:7 › flow › two',
      '[chromium] c.spec.ts:14:7 › flow › three',
    ],
  );
});

test('playwright: every listed test in exactly one shard passes', () => {
  const reports = new Map([[1, pwReport(ALL.slice(0, 2))], [2, pwReport(ALL.slice(2))]]);
  const r = checkPlaywright(LISTED, reports, 2);
  assert.deepEqual(r.problems, []);
  assert.equal(r.tests, 4);
  assert.deepEqual(r.shards.map((s) => s.tests), [2, 2]);
});

test('playwright: a flaky test (passed on its retry) still counts as run', () => {
  const reports = new Map([[1, pwReport([...ALL.slice(0, 1), spec('a.spec.ts', 12, 'one', 'flaky')])], [2, pwReport(ALL.slice(2))]]);
  const r = checkPlaywright(LISTED, reports, 2);
  assert.deepEqual(r.problems, []);
  assert.equal(r.shards[0].flaky, 1);
});

for (const status of ['unexpected', 'skipped', 'interrupted']) {
  test(`playwright: an ${status} test fails`, () => {
    const reports = new Map([[1, pwReport([...ALL.slice(0, 1), spec('a.spec.ts', 12, 'one', status)])], [2, pwReport(ALL.slice(2))]]);
    assert.match(problemsOf(checkPlaywright(LISTED, reports, 2)), new RegExp(`one \\(shard 1\\) is ${status}`));
  });
}

test('playwright: a missing shard fails, and its tests ran nowhere', () => {
  const r = checkPlaywright(LISTED, new Map([[1, pwReport(ALL.slice(0, 2))]]), 2);
  assert.match(problemsOf(r), /shard 2\/2 has no report/);
  assert.match(problemsOf(r), /b\.spec\.ts:12:7 › flow › two ran in no shard/);
});

test('playwright: a test two shards ran fails', () => {
  const reports = new Map([[1, pwReport(ALL.slice(0, 3))], [2, pwReport(ALL.slice(2))]]);
  assert.match(problemsOf(checkPlaywright(LISTED, reports, 2)), /two ran in shards 1, 2/);
});

test('playwright: an empty shard fails', () => {
  const reports = new Map([[1, pwReport(ALL)], [2, pwReport([])]]);
  assert.match(problemsOf(checkPlaywright(LISTED, reports, 2)), /shard 2\/2 ran no tests/);
});

test('playwright: a test --list does not know fails', () => {
  const reports = new Map([[1, pwReport(ALL.slice(0, 2))], [2, pwReport([...ALL.slice(2), spec('d.spec.ts', 12, 'new')])]]);
  assert.match(problemsOf(checkPlaywright(LISTED, reports, 2)), /d\.spec\.ts:12:7 › flow › new ran but --list does not know it/);
});

test('playwright: the other browser project is a different test', () => {
  const webkit = ALL.map((s) => spec(s.file, s.line, s.title, 'expected', 'webkit'));
  const r = checkPlaywright(LISTED, new Map([[1, pwReport(webkit)]]), 1);
  assert.match(problemsOf(r), /\[chromium\] a\.spec\.ts:3:7 › top level ran in no shard/);
});

test('playwright: an empty --list fails', () => {
  assert.match(problemsOf(checkPlaywright(pwReport([]), new Map([[1, pwReport(ALL)]]), 1)), /--list output holds no tests/);
});

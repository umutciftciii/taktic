// node --test .github/scripts/e2e-shard-plan.test.mjs
//
// The duration plan splits every listed file into exactly one shard, the same
// way on every runner, and degrades to test counts — never to a broken plan —
// when the history is missing, broken or does not know a file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARDED_JOBS } from './ci-shards.mjs';
import {
  DURATIONS_FILE,
  E2E_PROJECTS,
  buildPlan,
  fileWeights,
  listedFiles,
  mergeRuns,
  planShards,
  readDurations,
  reportFileMs,
  testListText,
} from './e2e-shard-plan.mjs';

const script = fileURLToPath(new URL('./e2e-shard-plan.mjs', import.meta.url));

/** A --list (or run) report: `files` is file → test count, every test in `project`. */
function listReport(files, project = 'chromium', durationMs) {
  return {
    suites: Object.entries(files).map(([file, n]) => ({
      title: file,
      file,
      specs: [],
      suites: [
        {
          title: 'flow',
          file,
          suites: [],
          specs: Array.from({ length: n }, (_, i) => ({
            title: `t${i}`,
            file,
            line: 10 + i,
            column: 3,
            tests: [{ projectName: project, status: 'expected', results: durationMs ? [{ duration: durationMs[file] / n }] : [] }],
          })),
        },
      ],
    })),
  };
}

const durationsText = (project, seconds) => JSON.stringify({ version: 1, runs: [], projects: { [project]: seconds } });

const allFiles = (plan) => plan.shards.flatMap((s) => s.files).sort();

// ── the split ────────────────────────────────────────────────────────────────

test('LPT: longest first onto the least loaded shard, ties to the lower shard', () => {
  const weights = new Map([['a', 50], ['b', 40], ['c', 30], ['d', 30], ['e', 20], ['f', 10]]);
  const shards = planShards(weights, 3);
  assert.deepEqual(shards.map((s) => s.files), [['a', 'f'], ['b', 'e'], ['c', 'd']]);
  assert.deepEqual(shards.map((s) => s.ms), [60, 60, 60]);
});

test('LPT: equal weights are ordered by path, so input order does not matter', () => {
  const files = ['x', 'b', 'm', 'a', 'q', 'c', 'z'];
  const one = planShards(new Map(files.map((f) => [f, 7])), 3);
  const two = planShards(new Map([...files].reverse().map((f) => [f, 7])), 3);
  assert.deepEqual(one, two);
});

test('LPT: more shards than files leaves the rest empty (the plan step then refuses)', () => {
  const shards = planShards(new Map([['a', 1]]), 3);
  assert.deepEqual(shards.map((s) => s.files.length), [1, 0, 0]);
  assert.throws(() => planShards(new Map(), 0), /not a positive integer/);
});

test('every listed file lands in exactly one shard, on a split far better than by count', () => {
  // Seven slow files then many quick ones, the shape --shard cut badly.
  const files = Object.fromEntries([...Array(40)].map((_, i) => [`f${String(i).padStart(2, '0')}.spec.ts`, 2]));
  const seconds = Object.fromEntries(Object.keys(files).map((f, i) => [f, i < 7 ? 120 : 5]));
  const plan = buildPlan('e2e', listReport(files), durationsText('chromium', seconds));
  assert.deepEqual(allFiles(plan), Object.keys(files).sort());
  assert.equal(new Set(allFiles(plan)).size, 40);
  const loads = plan.shards.map((s) => s.ms / 1000);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 120, `loads ${loads}`);
  assert.equal(plan.fallback, null);
  assert.deepEqual(plan.estimated, []);
  assert.equal(plan.shards.reduce((n, s) => n + s.tests, 0), 80);
});

test('the plan is the same however the listing orders its files', () => {
  const files = { 'b.spec.ts': 3, 'a.spec.ts': 1, 'c.spec.ts': 2, 'd.spec.ts': 5, 'e.spec.ts': 1 };
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  const text = durationsText('chromium', { 'a.spec.ts': 30, 'b.spec.ts': 10, 'c.spec.ts': 10, 'd.spec.ts': 9 });
  assert.deepEqual(buildPlan('e2e', listReport(files), text), buildPlan('e2e', listReport(reversed), text));
});

test('the shard counts are the layout ci-shards.mjs declares', () => {
  const files = Object.fromEntries([...Array(20)].map((_, i) => [`s${i}.spec.ts`, 1]));
  assert.equal(buildPlan('e2e', listReport(files), undefined).shards.length, SHARDED_JOBS.e2e.count);
  assert.equal(buildPlan('e2e-webkit', listReport(files, 'webkit'), undefined).shards.length, SHARDED_JOBS['e2e-webkit'].count);
  assert.deepEqual(E2E_PROJECTS, { e2e: 'chromium', 'e2e-webkit': 'webkit' });
  assert.throws(() => buildPlan('api', listReport(files), undefined), /not a sharded e2e job/);
});

test('only the job\'s own project is planned', () => {
  const report = listReport({ 'a.spec.ts': 2 });
  report.suites.push(...listReport({ 'w.spec.ts': 1 }, 'webkit').suites);
  assert.deepEqual([...listedFiles(report, 'chromium')], [['a.spec.ts', 2]]);
  assert.deepEqual([...listedFiles(report, 'webkit')], [['w.spec.ts', 1]]);
});

// ── what the history does not know ───────────────────────────────────────────

test('a file without history is estimated from its test count and the median seconds per test', () => {
  const files = new Map([['old1', 2], ['old2', 4], ['old3', 1], ['new', 3]]);
  // seconds per test: 10, 5, 30 → median 10
  const { weights, estimated, perTestSeconds } = fileWeights(files, { old1: 20, old2: 20, old3: 30, gone: 99 });
  assert.deepEqual(estimated, ['new']);
  assert.equal(perTestSeconds, 10);
  assert.equal(weights.get('new'), 30_000);
  assert.equal(weights.get('old1'), 20_000);
  assert.ok(!weights.has('gone'), 'a deleted file in the history is ignored');
});

test('no history at all: every test weighs the same, the split is by test count', () => {
  const plan = buildPlan('e2e', listReport({ 'a.spec.ts': 4, 'b.spec.ts': 1, 'c.spec.ts': 1, 'd.spec.ts': 1, 'e.spec.ts': 1 }), undefined);
  assert.equal(plan.fallback, 'the durations file is missing');
  assert.equal(plan.durations, null);
  assert.equal(plan.perTestSeconds, 1);
  assert.deepEqual(plan.shards.map((s) => s.tests), [4, 2, 1, 1]);
});

for (const [what, text, reason] of [
  ['not JSON', '{"version": 1,', /not JSON/],
  ['another version', JSON.stringify({ version: 2, projects: { chromium: { 'a.spec.ts': 1 } } }), /version is 2/],
  ['no entry for the project', JSON.stringify({ version: 1, projects: { webkit: { 'a.spec.ts': 1 } } }), /no durations for project "chromium"/],
  ['a negative entry', durationsText('chromium', { 'a.spec.ts': -1 }), /"a\.spec\.ts" has -1 seconds/],
  ['a zero entry', durationsText('chromium', { 'a.spec.ts': 0 }), /has 0 seconds/],
  ['a string entry', durationsText('chromium', { 'a.spec.ts': '12' }), /has "12" seconds/],
  ['a list for the project', JSON.stringify({ version: 1, projects: { chromium: [1, 2] } }), /no durations for project/],
  ['null', 'null', /version is undefined/],
]) {
  test(`a durations file with ${what} falls back to test counts and still covers every file`, () => {
    assert.match(readDurations(text, 'chromium').problem, reason);
    const plan = buildPlan('e2e', listReport({ 'a.spec.ts': 1, 'b.spec.ts': 2, 'c.spec.ts': 1, 'd.spec.ts': 1, 'e.spec.ts': 3 }), text);
    assert.match(plan.fallback, reason);
    assert.deepEqual(allFiles(plan), ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts']);
  });
}

// ── the history ──────────────────────────────────────────────────────────────

test('update: each run is scaled to its own total, so a slow runner does not move the weights', () => {
  const fast = new Map([['a', 100], ['b', 300]]);
  const slow = new Map([['a', 200], ['b', 600]]);
  const weights = mergeRuns([fast, slow, new Map([['a', 150], ['b', 450]])]);
  // shares 0.25 / 0.75 in every run; median total 600 ms
  assert.deepEqual(weights, { a: 0.2, b: 0.5 });
});

test('update: one outlier run is outvoted by the median', () => {
  const normal = () => new Map([['a', 10_000], ['b', 10_000]]);
  const weights = mergeRuns([normal(), normal(), new Map([['a', 90_000], ['b', 10_000]])]);
  assert.deepEqual(weights, { a: 10, b: 10 });
});

test('update: a run\'s per-file time counts every attempt, for the job\'s project only', () => {
  const report = listReport({ 'a.spec.ts': 2 }, 'chromium', { 'a.spec.ts': 4000 });
  report.suites[0].suites[0].specs[0].tests[0].results.push({ duration: 500 });
  report.suites.push(...listReport({ 'w.spec.ts': 1 }, 'webkit', { 'w.spec.ts': 9000 }).suites);
  assert.deepEqual([...reportFileMs(report, 'chromium')], [['a.spec.ts', 4500]]);
});

test('the committed durations file is valid for both projects', () => {
  const text = readFileSync(DURATIONS_FILE, 'utf8');
  for (const project of Object.values(E2E_PROJECTS)) {
    const { seconds, problem } = readDurations(text, project);
    assert.equal(problem, undefined, `${project}: ${problem}`);
    assert.ok(Object.keys(seconds).length > 10, `${project} has only ${Object.keys(seconds).length} files`);
  }
});

// ── the CLI a shard runs ─────────────────────────────────────────────────────

test('plan: writes this shard\'s --test-list and the whole plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-plan-'));
  const files = Object.fromEntries([...Array(12)].map((_, i) => [`s${String(i).padStart(2, '0')}.spec.ts`, 1]));
  writeFileSync(join(dir, 'list.json'), JSON.stringify(listReport(files, 'webkit')));
  const lists = [];
  for (const shard of [1, 2, 3, 4, 5]) {
    execFileSync(process.execPath, [script, 'plan', 'e2e-webkit', String(shard), join(dir, 'list.json'), join(dir, `l${shard}.txt`), join(dir, `out/p${shard}.json`)], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
    lists.push(readFileSync(join(dir, `l${shard}.txt`), 'utf8'));
  }
  const lines = lists.flatMap((l) => l.trim().split('\n'));
  assert.ok(lines.every((l) => /^\[webkit\] › s\d\d\.spec\.ts$/.test(l)), lines.join('\n'));
  assert.deepEqual(lines.map((l) => l.split(' › ')[1]).sort(), Object.keys(files).sort());
  // Every shard wrote the same plan.
  const plans = [1, 2, 3, 4, 5].map((s) => readFileSync(join(dir, `out/p${s}.json`), 'utf8'));
  assert.equal(new Set(plans).size, 1);
  assert.equal(testListText(JSON.parse(plans[0]), 3), lists[2]);
});

test('plan: a shard planned no files fails instead of running nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-plan-'));
  writeFileSync(join(dir, 'list.json'), JSON.stringify(listReport({ 'only.spec.ts': 1 })));
  const run = (shard) =>
    execFileSync(process.execPath, [script, 'plan', 'e2e', String(shard), join(dir, 'list.json'), join(dir, 'l.txt'), join(dir, 'p.json')], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
      encoding: 'utf8',
    });
  run(1);
  assert.throws(() => run(2), (e) => e.status === 1 && /shard 2\/4 was planned no files/.test(e.stdout));
  assert.throws(() => run(9), (e) => e.status === 1 && /shard 9 is not one of e2e's 4/.test(e.stdout));
});

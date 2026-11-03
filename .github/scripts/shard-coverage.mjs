// Shard coverage: every test ran, exactly once, and passed (CI-PERF-001).
//
// A sharded suite can go green while testing less than the whole: a shard
// whose matrix entry was dropped, a shard that selected nothing, a file two
// shards both ran while another ran in neither. None of that shows up in a
// shard's own result, so this check reads every shard's report and compares
// their union with what the suite holds:
//
//   API (Vitest)       every file under apps/api/test that Vitest includes ran
//                      in exactly one shard, every test in it passed, and each
//                      shard reported (none missing, none empty)
//   e2e (Playwright)   every test `playwright test --list` finds for the
//                      project ran in exactly one shard and ended expected or
//                      flaky (flaky = failed once, passed on the retry the
//                      suite already allows), and each shard reported
//   e2e shard plan     each shard ran exactly the spec files the duration plan
//                      (e2e-shard-plan.mjs) gives it, and the plan it wrote is
//                      the one this check computes again from the static
//                      job's listing and the committed durations
//
// A skipped, pending or todo test counts as not run: the suites have none
// today, and a test that stops running should be a decision someone sees.
//
//   node .github/scripts/shard-coverage.mjs <reports dir>
//
// <reports dir> holds one directory per shard, named `test-report-<job>-<i>`,
// each with the shard's `results.json` (and, for an e2e shard, its
// `plan.json`), and `expected-<job>.json` for each Playwright job (the --list
// output).

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARDED_JOBS, shardIndexes } from './ci-shards.mjs';
import { DURATIONS_FILE, buildPlan, reportFileMs } from './e2e-shard-plan.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const apiRoot = join(repoRoot, 'apps/api');

/** The API spec files Vitest includes (`test/**\/*.spec.ts`), relative to apps/api. */
export function apiSpecFiles(root = apiRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.spec.ts')) out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(join(root, 'test'));
  return out.sort();
}

/** A Vitest report's file path, made relative to apps/api wherever the shard ran. */
function apiRelative(name) {
  const at = name.lastIndexOf('/apps/api/');
  return at === -1 ? name : name.slice(at + '/apps/api/'.length);
}

const PASSED_TEST = new Set(['passed']);
const PASSED_PLAYWRIGHT = new Set(['expected', 'flaky']);

/**
 * @param {string[]} expectedFiles  spec files relative to apps/api
 * @param {Map<number, object|undefined>} reports  shard index → Vitest JSON report
 * @param {number} count  shards the layout declares
 */
export function checkVitest(expectedFiles, reports, count) {
  const problems = [];
  const shards = [];
  const ranIn = new Map();

  for (const index of shardIndexes(count)) {
    const report = reports.get(index);
    if (!report) {
      problems.push(`shard ${index}/${count} has no report`);
      continue;
    }
    let tests = 0;
    for (const file of report.testResults ?? []) {
      const path = apiRelative(file.name);
      ranIn.set(path, [...(ranIn.get(path) ?? []), index]);
      const results = file.assertionResults ?? [];
      if (results.length === 0) problems.push(`${path} (shard ${index}) reported no tests`);
      for (const t of results) {
        tests += 1;
        if (!PASSED_TEST.has(t.status)) problems.push(`${path} › ${t.fullName} (shard ${index}) is ${t.status}`);
      }
      if (file.status !== 'passed') problems.push(`${path} (shard ${index}) is ${file.status}: ${file.message ?? ''}`.trim());
    }
    const files = report.testResults?.length ?? 0;
    if (files === 0) problems.push(`shard ${index}/${count} ran no files`);
    const ms = Math.max(0, ...(report.testResults ?? []).map((f) => f.endTime ?? 0)) - (report.startTime ?? 0);
    shards.push({ index, files, tests, seconds: Math.round(ms / 1000) });
  }

  for (const file of expectedFiles) {
    const where = ranIn.get(file);
    if (!where) problems.push(`${file} ran in no shard`);
    else if (where.length > 1) problems.push(`${file} ran in shards ${where.join(', ')}`);
  }
  for (const file of ranIn.keys()) {
    if (!expectedFiles.includes(file)) problems.push(`${file} ran but is not one of the suite's files`);
  }

  return { problems, shards, files: expectedFiles.length, tests: shards.reduce((n, s) => n + s.tests, 0) };
}

/** Every test of a Playwright JSON report, as `{ key, status }`. */
export function playwrightTests(report) {
  const out = [];
  const visit = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const path = [...titles, spec.title].join(' › ');
        out.push({ key: `[${t.projectName}] ${spec.file}:${spec.line}:${spec.column} › ${path}`, status: t.status });
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  };
  // The top-level suites are the files; their titles are already in spec.file.
  for (const file of report.suites ?? []) visit(file, []);
  return out;
}

/**
 * @param {object} expected  `playwright test --list --reporter=json` for the job's project
 * @param {Map<number, object|undefined>} reports  shard index → Playwright JSON report
 * @param {number} count  shards the layout declares
 */
export function checkPlaywright(expected, reports, count) {
  const problems = [];
  const shards = [];
  const ranIn = new Map();
  const wanted = playwrightTests(expected).map((t) => t.key);
  if (wanted.length === 0) problems.push('the --list output holds no tests');

  for (const index of shardIndexes(count)) {
    const report = reports.get(index);
    if (!report) {
      problems.push(`shard ${index}/${count} has no report`);
      continue;
    }
    const tests = playwrightTests(report);
    for (const t of tests) {
      ranIn.set(t.key, [...(ranIn.get(t.key) ?? []), index]);
      if (!PASSED_PLAYWRIGHT.has(t.status)) problems.push(`${t.key} (shard ${index}) is ${t.status}`);
    }
    if (tests.length === 0) problems.push(`shard ${index}/${count} ran no tests`);
    const flaky = tests.filter((t) => t.status === 'flaky').length;
    shards.push({ index, tests: tests.length, flaky, seconds: Math.round((report.stats?.duration ?? 0) / 1000) });
  }

  for (const key of wanted) {
    const where = ranIn.get(key);
    if (!where) problems.push(`${key} ran in no shard`);
    else if (where.length > 1) problems.push(`${key} ran in shards ${where.join(', ')}`);
  }
  for (const key of ranIn.keys()) {
    if (!wanted.includes(key)) problems.push(`${key} ran but --list does not know it`);
  }

  return { problems, shards, tests: wanted.length };
}

/**
 * Each shard ran exactly its part of the plan, and wrote the same plan.
 *
 * @param {object} plan  buildPlan() for the job, from the static listing
 * @param {Map<number, object|undefined>} shardPlans  shard index → the plan.json it wrote
 * @param {Map<number, object|undefined>} reports  shard index → Playwright JSON report
 */
export function checkPlan(plan, shardPlans, reports) {
  const problems = [];
  const shards = [];
  const planned = new Map();
  for (const s of plan.shards) for (const f of s.files) planned.set(f, [...(planned.get(f) ?? []), s.index]);
  for (const [file, where] of planned) if (where.length > 1) problems.push(`the plan gives ${file} to shards ${where.join(', ')}`);
  const expected = JSON.stringify(plan);

  for (const s of plan.shards) {
    const own = shardPlans.get(s.index);
    if (!own) problems.push(`shard ${s.index}/${plan.count} wrote no plan`);
    else if (JSON.stringify(own) !== expected) {
      const theirs = new Set(own.shards?.find((o) => o.index === s.index)?.files ?? []);
      const diff = [...s.files.filter((f) => !theirs.has(f)).map((f) => `-${f}`), ...[...theirs].filter((f) => !s.files.includes(f)).map((f) => `+${f}`)];
      problems.push(
        `shard ${s.index}/${plan.count} planned differently from this check (durations ${own.durations ?? 'none'} vs ${plan.durations ?? 'none'}; ` +
          `its own files vs this check's: ${diff.length ? diff.join(' ') : 'same files, other fields differ'})`,
      );
    }
    const report = reports.get(s.index);
    if (!report) {
      shards.push({ index: s.index, planned: Math.round(s.ms / 1000), seconds: null });
      continue;
    }
    const ran = reportFileMs(report, plan.project);
    const want = new Set(s.files);
    for (const f of s.files) if (!ran.has(f)) problems.push(`${f} was planned for shard ${s.index} but did not run there`);
    for (const f of ran.keys()) if (!want.has(f)) problems.push(`${f} ran in shard ${s.index}, which the plan did not give it`);
    const ms = [...ran.values()].reduce((a, b) => a + b, 0);
    shards.push({ index: s.index, planned: Math.round(s.ms / 1000), seconds: Math.round(ms / 1000) });
  }
  return { problems, shards };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function shardReports(dir, jobId, count, file = 'results.json') {
  return new Map(shardIndexes(count).map((i) => [i, readJson(join(dir, `test-report-${jobId}-${i}`, file))]));
}

function main(dir) {
  const lines = [];
  let failed = false;

  const api = SHARDED_JOBS.api;
  const apiResult = checkVitest(apiSpecFiles(), shardReports(dir, 'api', api.count), api.count);
  lines.push(`#### ${api.name}: ${apiResult.files} files, ${apiResult.tests} tests`, '', '| shard | files | tests | seconds |', '|---|---|---|---|');
  for (const s of apiResult.shards) lines.push(`| ${s.index}/${api.count} | ${s.files} | ${s.tests} | ${s.seconds} |`);
  lines.push('');
  failed ||= apiResult.problems.length > 0;
  for (const p of apiResult.problems) lines.push(`- ✗ ${p}`);

  for (const jobId of ['e2e', 'e2e-webkit']) {
    const job = SHARDED_JOBS[jobId];
    const expected = readJson(join(dir, `expected-${jobId}.json`));
    const result = expected
      ? checkPlaywright(expected, shardReports(dir, jobId, job.count), job.count)
      : { problems: [`expected-${jobId}.json is missing`], shards: [], tests: 0 };
    lines.push(`#### ${job.name}: ${result.tests} tests`, '', '| shard | tests | flaky | seconds |', '|---|---|---|---|');
    for (const s of result.shards) lines.push(`| ${s.index}/${job.count} | ${s.tests} | ${s.flaky} | ${s.seconds} |`);
    lines.push('');
    failed ||= result.problems.length > 0;
    for (const p of result.problems) lines.push(`- ✗ ${p}`);

    if (expected) {
      const durations = existsSync(DURATIONS_FILE) ? readFileSync(DURATIONS_FILE, 'utf8') : undefined;
      const plan = buildPlan(jobId, expected, durations);
      const planResult = checkPlan(plan, shardReports(dir, jobId, job.count, 'plan.json'), shardReports(dir, jobId, job.count));
      lines.push(`${job.name} plan${plan.fallback ? ` (fallback to test counts: ${plan.fallback})` : ''}${plan.estimated.length ? `, ${plan.estimated.length} file(s) estimated` : ''}:`, '');
      lines.push('| shard | files | planned s | test s |', '|---|---|---|---|');
      for (const s of planResult.shards) lines.push(`| ${s.index}/${job.count} | ${plan.shards[s.index - 1].files.length} | ${s.planned} | ${s.seconds ?? '—'} |`);
      lines.push('');
      failed ||= planResult.problems.length > 0;
      for (const p of planResult.problems) lines.push(`- ✗ ${p}`);
    }
  }

  const head = failed ? '### Shard coverage FAILED' : '### Shard coverage: every test ran exactly once and passed';
  const text = [head, '', ...lines].join('\n') + '\n';
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  } catch {}
  console.log(text);
  if (failed) console.log('::error::shard coverage failed — see the list above');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node .github/scripts/shard-coverage.mjs <reports dir>');
    process.exitCode = 2;
  } else {
    process.exitCode = main(resolve(dir));
  }
}

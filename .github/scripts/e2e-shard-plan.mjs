// Duration-balanced e2e shards (CI-PERF-002C).
//
// Playwright's --shard cuts the file list into slices of equal test count, so
// one slice of slow files and one of quick ones ran side by side: on the four
// sharded PR runs before this, the slowest Chromium shard spent 511–583 s in
// tests while the quickest spent 252–361 s. The job is done when its slowest
// shard is, so that gap was the critical path.
//
// This plans the split from measured time instead. Its inputs are two files,
// both fixed by the commit under test:
//
//   - what `playwright test --list --reporter=json` finds for the project,
//     which every shard lists for itself (it starts no server), and
//   - .github/scripts/e2e-shard-durations.json, each spec file's seconds as measured
//     on earlier CI runs (see `update` below).
//
// Every shard computes the same plan from the same inputs and runs its own
// part through Playwright's documented `--test-list` option; nothing reads the
// internal PWTEST_SHARD_WEIGHTS. The shard writes the whole plan next to its
// report, and shard-coverage computes it again from the static job's listing
// and checks that each shard ran exactly the files the plan gave it — so the
// plan is reproducible, and a shard that ran something else fails the run.
//
// What the history can not say is filled in, never guessed at random:
//
//   a file with no history     (new or renamed) is estimated from its test
//                              count times the median seconds per test of the
//                              files that do have history
//   a missing or broken file   the whole project falls back to test counts
//                              alone, with a warning — the split is then about
//                              as good as --shard's, never worse than "every
//                              file runs somewhere"
//
// The seconds are relative weights, not a prediction: runners differ in speed
// (on the same files, one run's shard took 309 s and another's 473 s), so
// `update` scales each run to its own total before taking the median, and
// one fast or slow run does not move the plan.
//
//   node .github/scripts/e2e-shard-plan.mjs plan <job> <shard> <list.json> <test-list out> <plan.json out>
//   node .github/scripts/e2e-shard-plan.mjs update <run dir>...   (writes the durations file)

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARDED_JOBS, shardIndexes } from './ci-shards.mjs';

export const DURATIONS_FILE = fileURLToPath(new URL('./e2e-shard-durations.json', import.meta.url));

/** The Playwright project each sharded e2e job runs. */
export const E2E_PROJECTS = { e2e: 'chromium', 'e2e-webkit': 'webkit' };

/** Spec file (relative to the test directory) → number of tests, for one project of a --list report. */
export function listedFiles(report, project) {
  const files = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName === project) files.set(spec.file, (files.get(spec.file) ?? 0) + 1);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A durations file's seconds for `project`, or why it can not be used. Any
 * entry that is not a positive finite number rejects the whole project: a
 * partly wrong history is not one to plan from.
 */
export function readDurations(text, project) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { problem: `not JSON (${e.message})` };
  }
  if (data?.version !== 1) return { problem: `version is ${JSON.stringify(data?.version)}, not 1` };
  const seconds = data.projects?.[project];
  if (!seconds || typeof seconds !== 'object' || Array.isArray(seconds)) return { problem: `no durations for project "${project}"` };
  for (const [file, s] of Object.entries(seconds)) {
    if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return { problem: `"${file}" has ${JSON.stringify(s)} seconds` };
  }
  return { seconds };
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Each listed file's weight in whole milliseconds (integers, so every shard
 * sums them to the same total), and which of them were estimated.
 *
 * @param {Map<string, number>} files  spec file → test count
 * @param {Record<string, number> | undefined} seconds  history; undefined = fall back to test counts
 */
export function fileWeights(files, seconds) {
  const known = seconds ? [...files].filter(([f]) => Object.hasOwn(seconds, f)) : [];
  // Without history every test weighs one second: the split is by test count.
  const perTest = known.length ? median(known.map(([f, n]) => seconds[f] / n)) : 1;
  const weights = new Map();
  const estimated = [];
  for (const [file, tests] of files) {
    const s = seconds && Object.hasOwn(seconds, file) ? seconds[file] : (estimated.push(file), tests * perTest);
    weights.set(file, Math.max(1, Math.round(s * 1000)));
  }
  return { weights, estimated, perTestSeconds: perTest };
}

/**
 * Longest file first, each onto the shard with the least planned time (ties:
 * lower shard index; equal weights: file path) — the classic LPT rule, which
 * is never worse than 4/3 of the best possible split. Fully deterministic:
 * the same weights give the same plan on every runner.
 *
 * @param {Map<string, number>} weights  file → milliseconds
 * @returns {{ index: number, files: string[], ms: number }[]}
 */
export function planShards(weights, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count ${count} is not a positive integer`);
  const shards = shardIndexes(count).map((index) => ({ index, files: [], ms: 0 }));
  const order = [...weights].sort(([fa, a], [fb, b]) => b - a || (fa < fb ? -1 : fa > fb ? 1 : 0));
  for (const [file, ms] of order) {
    let target = shards[0];
    for (const s of shards) if (s.ms < target.ms) target = s;
    target.files.push(file);
    target.ms += ms;
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/**
 * The whole plan for one job, from the --list report and the durations file's
 * text (undefined when the file is missing). Pure: shard-coverage calls it
 * with the static job's listing and must get exactly what each shard got.
 */
export function buildPlan(jobId, listReport, durationsText) {
  const project = E2E_PROJECTS[jobId];
  const job = SHARDED_JOBS[jobId];
  if (!project || !job) throw new Error(`"${jobId}" is not a sharded e2e job`);
  const files = listedFiles(listReport, project);
  const history = durationsText === undefined ? { problem: 'the durations file is missing' } : readDurations(durationsText, project);
  const { weights, estimated, perTestSeconds } = fileWeights(files, history.seconds);
  return {
    job: jobId,
    project,
    count: job.count,
    durations: durationsText === undefined ? null : createHash('sha256').update(durationsText).digest('hex'),
    fallback: history.problem ?? null,
    estimated,
    perTestSeconds: Math.round(perTestSeconds * 1000) / 1000,
    shards: planShards(weights, job.count).map((s) => ({ ...s, tests: s.files.reduce((n, f) => n + files.get(f), 0) })),
  };
}

/** The --test-list file for one shard: one whole spec file per line, for the job's project only. */
export function testListText(plan, index) {
  const shard = plan.shards.find((s) => s.index === index);
  if (!shard) throw new Error(`plan has no shard ${index}`);
  return shard.files.map((f) => `[${plan.project}] › ${f}`).join('\n') + '\n';
}

/** Human-readable lines describing a plan, for the job log and summary. */
export function describePlan(plan) {
  const lines = [`${plan.job} (${plan.project}): ${plan.shards.reduce((n, s) => n + s.files.length, 0)} files in ${plan.count} shards`];
  if (plan.fallback) lines.push(`fallback to test counts: ${plan.fallback}`);
  if (plan.estimated.length) lines.push(`no history, estimated at ${plan.perTestSeconds} s per test: ${plan.estimated.join(', ')}`);
  for (const s of plan.shards) lines.push(`  shard ${s.index}/${plan.count}: ${s.files.length} files, ${s.tests} tests, ~${Math.round(s.ms / 1000)} s planned`);
  return lines;
}

// ── update: the durations file from earlier runs' reports ────────────────────

/** Spec file → milliseconds the tests spent in it, every attempt included, for one Playwright JSON report. */
export function reportFileMs(report, project) {
  const ms = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName !== project) continue;
        for (const r of t.results ?? []) ms.set(spec.file, (ms.get(spec.file) ?? 0) + (r.duration ?? 0));
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return ms;
}

/**
 * Seconds per file from several runs. Each run is first scaled to its own
 * total (a file's share of that run), so a run on a slow runner counts the
 * same as one on a fast one; the file's weight is its median share times the
 * median total. A file that ran in only some of the runs uses those.
 *
 * @param {Map<string, number>[]} runs  one file → ms map per run
 */
export function mergeRuns(runs) {
  const totals = runs.map((r) => [...r.values()].reduce((a, b) => a + b, 0)).filter((t) => t > 0);
  if (totals.length === 0) return {};
  const shares = new Map();
  for (const run of runs) {
    const total = [...run.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    for (const [file, ms] of run) if (ms > 0) shares.set(file, [...(shares.get(file) ?? []), ms / total]);
  }
  const scale = median(totals) / 1000;
  return Object.fromEntries(
    [...shares].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, s]) => [file, Math.max(0.1, Math.round(median(s) * scale * 10) / 10)]),
  );
}

function update(runDirs) {
  const projects = {};
  const runs = [];
  for (const [jobId, project] of Object.entries(E2E_PROJECTS)) {
    const perRun = [];
    for (const dir of runDirs) {
      const run = new Map();
      for (const index of shardIndexes(SHARDED_JOBS[jobId].count)) {
        const path = join(dir, `test-report-${jobId}-${index}`, 'results.json');
        if (!existsSync(path)) throw new Error(`${path} is missing: a run used for history must have every shard's report`);
        for (const [file, ms] of reportFileMs(JSON.parse(readFileSync(path, 'utf8')), project)) {
          if (run.has(file)) throw new Error(`${file} ran in two ${jobId} shards of ${dir}`);
          run.set(file, ms);
        }
      }
      perRun.push(run);
    }
    projects[project] = mergeRuns(perRun);
  }
  for (const dir of runDirs) runs.push(resolve(dir).split('/').pop());
  const text = JSON.stringify({ version: 1, runs, projects }, null, 2) + '\n';
  writeFileSync(DURATIONS_FILE, text);
  for (const project of Object.values(E2E_PROJECTS)) console.log(`${project}: ${Object.keys(projects[project]).length} files`);
  console.log(`wrote ${DURATIONS_FILE}`);
}

// ── plan: this shard's test list ─────────────────────────────────────────────

function plan(jobId, shardArg, listPath, testListOut, planOut) {
  const index = Number(shardArg);
  const listReport = JSON.parse(readFileSync(listPath, 'utf8'));
  const durationsText = existsSync(DURATIONS_FILE) ? readFileSync(DURATIONS_FILE, 'utf8') : undefined;
  const p = buildPlan(jobId, listReport, durationsText);
  const lines = describePlan(p);
  console.log(lines.join('\n'));
  if (p.fallback) console.log(`::warning::e2e shard plan for ${jobId} falls back to test counts: ${p.fallback}`);
  if (p.estimated.length) console.log(`::notice::${p.estimated.length} ${jobId} spec file(s) have no duration history and were estimated`);
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['```', ...lines, '```', ''].join('\n'));
  } catch {}

  const shard = p.shards.find((s) => s.index === index);
  if (!shard) throw new Error(`shard ${shardArg} is not one of ${jobId}'s ${p.count}`);
  // An empty list would make Playwright run nothing and pass; say so here.
  if (shard.files.length === 0) throw new Error(`shard ${index}/${p.count} was planned no files`);
  for (const out of [testListOut, planOut]) mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(testListOut, testListText(p, index));
  writeFileSync(planOut, JSON.stringify(p, null, 2) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'plan' && args.length === 5) process.exitCode = plan(...args);
    else if (command === 'update' && args.length > 0) update(args);
    else {
      console.error('usage: e2e-shard-plan.mjs plan <job> <shard> <list.json> <test-list out> <plan.json out>');
      console.error('       e2e-shard-plan.mjs update <run dir>...');
      process.exitCode = 2;
    }
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  }
}

// node --test .github/scripts/post-merge-gate.test.mjs
//
// One scenario that proves reuse, then every way the chain can break — each
// must end in a full run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVIDENCE_PREFIX, REQUIRED_JOBS, evaluate } from './post-merge-gate.mjs';

const sha = (c) => c.repeat(40);
const BASE = sha('a'); // main before the merge
const HEAD = sha('b'); // PR head
const MERGED = sha('c'); // what landed on main
const TESTED = sha('d'); // merge commit the PR run checked out
const TREE = sha('e');

function scenario(overrides = {}) {
  const s = {
    push: { event: 'push', ref: 'refs/heads/main', defaultBranch: 'main', before: BASE, after: MERGED, forced: false },
    commits: {
      [MERGED]: { tree: TREE, parents: [BASE, HEAD] },
      [TESTED]: { tree: TREE, parents: [BASE, HEAD] },
    },
    pulls: [{ number: 7, merged_at: '2026-09-28T13:00:34Z', merge_commit_sha: MERGED, base: { ref: 'main' }, head: { sha: HEAD } }],
    runs: [
      { id: 100, run_number: 5, event: 'pull_request', head_sha: HEAD, status: 'completed', conclusion: 'success', created_at: '2026-09-28T11:30:11Z', html_url: 'u' },
    ],
    jobs: REQUIRED_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })).concat([
      { name: 'record tested merge commit', status: 'completed', conclusion: 'success' },
    ]),
    artifacts: [{ name: EVIDENCE_PREFIX + TESTED, expired: false }],
  };
  return typeof overrides === 'function' ? (overrides(s), s) : { ...s, ...overrides };
}

function apiFor(s) {
  return {
    async commit(x) {
      if (!s.commits[x]) throw new Error(`GET /git/commits/${x} → HTTP 404`);
      return s.commits[x];
    },
    pullsForCommit: async () => s.pulls,
    runsForHead: async () => s.runs,
    jobs: async () => s.jobs,
    artifacts: async () => s.artifacts,
  };
}

const run = (s, opts) => evaluate(s.push, apiFor(s), opts);

async function assertFull(s, pattern) {
  const d = await run(s);
  assert.equal(d.reuse, false, `expected a full run, got reuse: ${d.reason}`);
  assert.match(d.reason, pattern);
}

test('reuses only when the tested merge commit has the landed tree on the landed base', async () => {
  const d = await run(scenario());
  assert.equal(d.reuse, true, d.reason);
  assert.equal(d.pr, 7);
  assert.equal(d.runId, 100);
  assert.equal(d.testedSha, TESTED);
});

test('squash merge: one parent, same tree and base → reuse', async () => {
  const d = await run(scenario((s) => (s.commits[MERGED] = { tree: TREE, parents: [BASE] })));
  assert.equal(d.reuse, true, d.reason);
});

// ── the push itself ─────────────────────────────────────────────────────────

test('pull_request event → full', () => assertFull(scenario((s) => (s.push.event = 'pull_request')), /not push/));
test('push to another branch → full', () => assertFull(scenario((s) => (s.push.ref = 'refs/heads/x')), /not the default branch/));
test('forced push → full', () => assertFull(scenario((s) => (s.push.forced = true)), /forced/));
test('branch creation (zero before) → full', () => assertFull(scenario((s) => (s.push.before = sha('0'))), /no previous tip/));
test('several commits in one push (rebase merge) → full', () =>
  assertFull(scenario((s) => (s.commits[MERGED].parents = [sha('f'), HEAD])), /more than one commit/));

// ── which PR produced it ────────────────────────────────────────────────────

test('direct push: no PR → full', () => assertFull(scenario({ pulls: [] }), /direct push/));
test('commit only contained in an open PR → full', () =>
  assertFull(scenario((s) => (s.pulls[0].merged_at = null)), /direct push/));
test('PR merged as a different commit → full', () =>
  assertFull(scenario((s) => (s.pulls[0].merge_commit_sha = sha('f'))), /direct push/));
test('PR merged into another branch → full', () =>
  assertFull(scenario((s) => (s.pulls[0].base.ref = 'release')), /direct push/));
test('two PRs claim the commit → full', () =>
  assertFull(scenario((s) => s.pulls.push({ ...s.pulls[0], number: 8 })), /direct push/));

// ── the PR run ──────────────────────────────────────────────────────────────

test('no PR run → full', () => assertFull(scenario({ runs: [] }), /no pull_request CI run/));
test('PR run still in progress → full', () =>
  assertFull(scenario((s) => Object.assign(s.runs[0], { status: 'in_progress', conclusion: null })), /in_progress/));
test('PR run failed → full', () => assertFull(scenario((s) => (s.runs[0].conclusion = 'failure')), /concluded failure/));
test('PR run cancelled → full', () => assertFull(scenario((s) => (s.runs[0].conclusion = 'cancelled')), /concluded cancelled/));
test('only an older run succeeded, the latest failed → full', () =>
  assertFull(
    scenario((s) =>
      s.runs.push({ ...s.runs[0], id: 101, run_number: 6, conclusion: 'failure', created_at: '2026-09-28T12:00:00Z' }),
    ),
    /run 101 concluded failure/,
  ));
test('a push-event run for the same head is not PR evidence → full', () =>
  assertFull(scenario((s) => (s.runs[0].event = 'push')), /no pull_request CI run/));

for (const name of REQUIRED_JOBS) {
  test(`required job skipped: ${name} → full`, () =>
    assertFull(scenario((s) => (s.jobs.find((j) => j.name === name).conclusion = 'skipped')), /skipped/));
  test(`required job missing: ${name} → full`, () =>
    assertFull(scenario((s) => (s.jobs = s.jobs.filter((j) => j.name !== name))), /has 0 jobs/));
}

// ── what the PR run tested ──────────────────────────────────────────────────

test('no evidence artifact (run predates the gate) → full', () =>
  assertFull(scenario({ artifacts: [] }), /exactly one tested merge commit \(found 0\)/));
test('expired evidence artifact → full', () =>
  assertFull(scenario((s) => (s.artifacts[0].expired = true)), /found 0/));
test('two different tested commits recorded → full', () =>
  assertFull(scenario((s) => s.artifacts.push({ name: EVIDENCE_PREFIX + sha('9'), expired: false })), /found 2/));
test('malformed evidence → full', () =>
  assertFull(scenario({ artifacts: [{ name: EVIDENCE_PREFIX + 'HEAD', expired: false }] }), /exactly one/));
test('tested commit unknown to GitHub → gate error, full', async () => {
  const s = scenario();
  delete s.commits[TESTED];
  await assert.rejects(run(s), /HTTP 404/); // main() turns any rejection into reuse=false
});

test('main advanced after the PR was tested → full', () =>
  assertFull(scenario((s) => (s.commits[TESTED].parents = [sha('f'), HEAD])), /tested on top of/));
test('same base but a different tree → full', () =>
  assertFull(scenario((s) => (s.commits[TESTED].tree = sha('f'))), /tested tree/));

// ── the job names the gate looks for are the ones ci.yml defines ────────────

test('REQUIRED_JOBS match the job names in ci.yml', () => {
  const yml = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const names = [...yml.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
  for (const name of REQUIRED_JOBS) assert.ok(names.includes(name), `ci.yml has no job named "${name}"`);
});

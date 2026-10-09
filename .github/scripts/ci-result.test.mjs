// node --test .github/scripts/ci-result.test.mjs
//
// The passing shape of each event, then every way a run can look green to a
// name-matching rule without having tested anything — each must fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FULL_JOBS, GATE_JOB, PR_JOBS, decide } from './ci-result.mjs';

const results = (overrides = {}, base = 'success') => ({
  [GATE_JOB]: { result: 'skipped', outputs: {} },
  ...Object.fromEntries(PR_JOBS.map((id) => [id, { result: base, outputs: {} }])),
  ...overrides,
});

const pushWith = (reuse, full) => ({
  [GATE_JOB]: { result: 'success', outputs: reuse === undefined ? {} : { reuse } },
  'pr-evidence': { result: 'skipped', outputs: {} },
  ...Object.fromEntries(FULL_JOBS.map((id) => [id, { result: full, outputs: {} }])),
});

// ── pull requests ───────────────────────────────────────────────────────────

test('pull request: every job succeeded on the head', () => {
  assert.equal(decide('pull_request', results()).ok, true);
});

for (const id of PR_JOBS) {
  for (const outcome of ['skipped', 'failure', 'cancelled']) {
    test(`pull request: ${id} ${outcome} fails the result`, () => {
      const d = decide('pull_request', results({ [id]: { result: outcome } }));
      assert.equal(d.ok, false);
      assert.match(d.reason, new RegExp(`${id}=${outcome}`));
    });
  }
  test(`pull request: ${id} missing fails the result`, () => {
    const needs = results();
    delete needs[id];
    assert.equal(decide('pull_request', needs).ok, false);
  });
}

test('pull request: everything skipped is not a pass', () => {
  assert.equal(decide('pull_request', results({}, 'skipped')).ok, false);
});

// ── pushes to main ──────────────────────────────────────────────────────────

test('push: proven reuse with the full jobs skipped passes', () => {
  assert.equal(decide('push', pushWith('true', 'skipped')).ok, true);
});

test('push: no reuse and every full job succeeded passes', () => {
  assert.equal(decide('push', pushWith('false', 'success')).ok, true);
  assert.equal(decide('push', pushWith(undefined, 'success')).ok, true);
});

test('push: no reuse and full jobs skipped fails', () => {
  assert.equal(decide('push', pushWith('false', 'skipped')).ok, false);
  assert.equal(decide('push', pushWith(undefined, 'skipped')).ok, false);
});

for (const id of FULL_JOBS) {
  test(`push: no reuse and ${id} failed fails the result`, () => {
    const needs = pushWith('false', 'success');
    needs[id] = { result: 'failure' };
    assert.equal(decide('push', needs).ok, false);
  });
  test(`push: reuse claimed but ${id} ran fails the result`, () => {
    const needs = pushWith('true', 'skipped');
    needs[id] = { result: 'success' };
    assert.equal(decide('push', needs).ok, false);
  });
}

for (const outcome of ['failure', 'cancelled', 'skipped']) {
  test(`push: gate ${outcome} fails the result`, () => {
    const needs = pushWith('true', 'skipped');
    needs[GATE_JOB] = { result: outcome, outputs: { reuse: 'true' } };
    assert.equal(decide('push', needs).ok, false);
  });
}

// ── anything else ───────────────────────────────────────────────────────────

test('another event, or no results at all, fails', () => {
  assert.equal(decide('workflow_dispatch', results()).ok, false);
  assert.equal(decide('pull_request', null).ok, false);
  assert.equal(decide('pull_request', {}).ok, false);
});

// ── ci.yml wires the job the way this file assumes ──────────────────────────

test('ci.yml: the CI result job runs always and needs every job it judges', () => {
  const yml = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = yml.slice(yml.indexOf('\njobs:\n'));
  const jobIds = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  for (const id of [GATE_JOB, ...PR_JOBS]) assert.ok(jobIds.includes(id), `ci.yml has no job "${id}"`);

  // The last job, so its block runs to the end of the file.
  assert.equal(jobIds.at(-1), 'ci-result', 'ci-result is the last job in ci.yml');
  const body = yml.slice(yml.indexOf('\n  ci-result:\n'));
  assert.match(body, /^ {4}name: CI result$/m);
  assert.match(body, /^ {4}if: always\(\)$/m);
  const needs = body.match(/^ {4}needs: \[([^\]]*)\]$/m)?.[1].split(',').map((s) => s.trim());
  assert.deepEqual([...needs].sort(), [GATE_JOB, ...PR_JOBS].sort());
  // Every other job is judged by it, so none may be left out of `needs`.
  assert.deepEqual(jobIds.filter((id) => id !== 'ci-result').sort(), [...needs].sort());
});

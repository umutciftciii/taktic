// node --test .github/scripts/ci-shards.test.mjs
//
// ci.yml's matrix jobs are laid out exactly as ci-shards.mjs says — the post-
// merge gate and the shard coverage check both rely on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SHARDED_JOBS, allShardJobNames, shardIndexes, shardJobName } from './ci-shards.mjs';

const yml = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');

/** The block of job `id` in ci.yml, up to the next job. */
function jobBlock(id) {
  const jobs = yml.slice(yml.indexOf('\njobs:\n'));
  const block = jobs.split(/^(?= {2}[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith(`  ${id}:`));
  assert.ok(block, `ci.yml has no job "${id}"`);
  return block;
}

test('shard names are what GitHub shows for a matrix job', () => {
  assert.equal(shardJobName(SHARDED_JOBS.api, 3), 'api tests (3/4)');
  assert.deepEqual(shardIndexes(5), [1, 2, 3, 4, 5]);
  const names = allShardJobNames();
  assert.equal(names.length, Object.values(SHARDED_JOBS).reduce((n, j) => n + j.count, 0));
  assert.equal(new Set(names).size, names.length);
});

for (const [id, job] of Object.entries(SHARDED_JOBS)) {
  test(`ci.yml: ${id} runs shards ${shardIndexes(job.count).join(', ')} under the names the gate requires`, () => {
    const block = jobBlock(id);
    assert.match(block, new RegExp(`^ {4}name: ${job.name} \\(\\$\\{\\{ matrix\\.shard \\}\\}/\\$\\{\\{ strategy\\.job-total \\}\\}\\)$`, 'm'));
    const shards = JSON.parse(block.match(/^ {8}shard: (\[[^\]]*\])$/m)?.[1] ?? 'null');
    assert.deepEqual(shards, shardIndexes(job.count));
    // One shard failing must not cancel the others: their reports are what
    // shard-coverage reads.
    assert.match(block, /^ {6}fail-fast: false$/m);
  });

  test(`ci.yml: ${id} passes its shard to the runner and uploads its report for shard-coverage`, () => {
    const block = jobBlock(id);
    if (id === 'api') {
      assert.match(block, /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/);
    } else {
      // CI-PERF-002C: the e2e shards run the files their duration plan gives
      // them, through Playwright's --test-list, and never also --shard (which
      // would cut that list again by count).
      assert.doesNotMatch(block, /\s--shard=/);
      assert.match(block, new RegExp(`node \\.github/scripts/e2e-shard-plan\\.mjs plan ${id} \\$\\{\\{ matrix\\.shard \\}\\} "\\$RUNNER_TEMP/e2e-list\\.json" \\\\\n +"\\$RUNNER_TEMP/e2e-test-list\\.txt" "\\$E2E_REPORT_DIR/plan\\.json"`));
      assert.match(block, /e2e(?::webkit)? --test-list="\$RUNNER_TEMP\/e2e-test-list\.txt"$/m);
      // The shard lists its project the way `static` does, or the plans differ.
      const listing = id === 'e2e-webkit' ? /E2E_WEBKIT=1 PLAYWRIGHT_JSON_OUTPUT_NAME=.*\n.*--list --reporter=json --project=webkit >/ : /^ {10}PLAYWRIGHT_JSON_OUTPUT_NAME=.*\n.*--list --reporter=json >/m;
      assert.match(block, listing);
      // Playwright's selection is checked against the plan before the tests.
      assert.match(block, new RegExp(`--list --reporter=json${id === 'e2e-webkit' ? ' --project=webkit' : ''} --test-list="\\$RUNNER_TEMP/e2e-test-list\\.txt" >/dev/null\\n +node \\.github/scripts/e2e-shard-plan\\.mjs verify "\\$E2E_REPORT_DIR/plan\\.json" \\$\\{\\{ matrix\\.shard \\}\\} "\\$RUNNER_TEMP/e2e-selected\\.json"`));
      // The plan is written before the tests run, into the uploaded directory.
      assert.ok(block.indexOf('e2e-shard-plan.mjs plan') < block.indexOf('--test-list='));
      assert.match(block, /^ {6}E2E_REPORT_DIR: \$\{\{ github\.workspace \}\}\/e2e\/\.artifacts\/shard-report$/m);
      assert.match(block, /^ {10}path: e2e\/\.artifacts\/shard-report$/m);
    }
    assert.match(block, new RegExp(`^ {10}name: test-report-${id}-\\$\\{\\{ matrix\\.shard \\}\\}$`, 'm'));
  });

  test(`ci.yml: every ${id} shard has a PostgreSQL service of its own`, () => {
    assert.match(jobBlock(id), /^ {4}services:\n(?: {6}#.*\n)* {6}postgres:\n/m);
  });
}

test('ci.yml: each API shard tests against a database named after it', () => {
  assert.match(jobBlock('api'), /^ {6}TEST_DATABASE_SLUG: api_shard_\$\{\{ matrix\.shard \}\}$/m);
});

test('ci.yml: pr-evidence runs the shard plan tests', () => {
  assert.match(jobBlock('pr-evidence'), /\.github\/scripts\/e2e-shard-plan\.test\.mjs/);
});

test('ci.yml: shard-coverage waits for every sharded job and the e2e listing', () => {
  const needs = jobBlock('shard-coverage').match(/^ {4}needs: \[([^\]]*)\]$/m)?.[1].split(',').map((s) => s.trim());
  for (const id of ['static', ...Object.keys(SHARDED_JOBS)]) assert.ok(needs?.includes(id), `shard-coverage does not need ${id}`);
});

// CI-HARDEN-001: `pnpm test:api` is a local tool, so nothing else would notice a
// change that breaks it. These run in pr-evidence, apart from the step they guard.
const stepsOf = (id) => jobBlock(id).split(/^(?= {6}- )/m);
const packageScripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
const runnerTestDir = new URL('../../scripts/test/', import.meta.url);
const runnerTests = readdirSync(runnerTestDir).filter((name) => name.endsWith('.test.mjs')).sort();

test('ci.yml: unit runs the local API runner tests, after the Prisma client its preflight reads', () => {
  const steps = stepsOf('unit');
  const generate = steps.findIndex((step) => step.includes('run: pnpm db:generate'));
  const runner = steps.findIndex((step) => /^ {8}run: pnpm test:api:runner$/m.test(step));
  assert.notEqual(runner, -1, 'the unit job does not run pnpm test:api:runner');
  assert.ok(generate !== -1 && generate < runner, 'pnpm test:api:runner runs before pnpm db:generate');
});

test('ci.yml: a failure in the unit tests does not hide the runner tests', () => {
  const step = stepsOf('unit').find((text) => text.includes('run: pnpm test:api:runner'));
  assert.match(step ?? '', /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
});

test('ci.yml: unit stays one job on no database, and the API shards are still four', () => {
  const block = jobBlock('unit');
  assert.doesNotMatch(block, /^ {4}services:$/m);
  assert.doesNotMatch(block, /^ {4}strategy:$/m);
  assert.equal(SHARDED_JOBS.api.count, 4);
});

test('package.json: test:api:runner names every test file of the runner', () => {
  assert.ok(runnerTests.length > 0);
  const named = packageScripts['test:api:runner'].split(/\s+/).filter((word) => word.endsWith('.test.mjs'));
  assert.deepEqual(named.sort(), runnerTests.map((name) => `scripts/test/${name}`));
});

test('the runner tests skip nothing: a green run means all of them ran', () => {
  for (const name of runnerTests) {
    const source = readFileSync(new URL(name, runnerTestDir), 'utf8');
    assert.doesNotMatch(source, /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:skip|only|todo):/, name);
  }
});

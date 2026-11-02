// node --test .github/scripts/ci-shards.test.mjs
//
// ci.yml's matrix jobs are laid out exactly as ci-shards.mjs says — the post-
// merge gate and the shard coverage check both rely on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    assert.match(block, /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/);
    assert.match(block, new RegExp(`^ {10}name: test-report-${id}-\\$\\{\\{ matrix\\.shard \\}\\}$`, 'm'));
  });

  test(`ci.yml: every ${id} shard has a PostgreSQL service of its own`, () => {
    assert.match(jobBlock(id), /^ {4}services:\n(?: {6}#.*\n)* {6}postgres:\n/m);
  });
}

test('ci.yml: each API shard tests against a database named after it', () => {
  assert.match(jobBlock('api'), /^ {6}TEST_DATABASE_SLUG: api_shard_\$\{\{ matrix\.shard \}\}$/m);
});

test('ci.yml: shard-coverage waits for every sharded job and the e2e listing', () => {
  const needs = jobBlock('shard-coverage').match(/^ {4}needs: \[([^\]]*)\]$/m)?.[1].split(',').map((s) => s.trim());
  for (const id of ['static', ...Object.keys(SHARDED_JOBS)]) assert.ok(needs?.includes(id), `shard-coverage does not need ${id}`);
});

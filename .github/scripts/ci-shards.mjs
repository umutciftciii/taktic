// The shard layout of ci.yml's matrix jobs (CI-PERF-001), in one place.
//
// The post-merge gate needs every shard's display name to recognise a full PR
// run, and the shard coverage check needs every shard's index to notice one
// that never reported. Both read it from here; `ci-shards.test.mjs` checks that
// ci.yml's matrices and job names say the same thing, so a shard added to or
// dropped from the workflow without this file fails the pull request that
// does it rather than quietly narrowing what "a full run" means.
//
// A shard is a slice of one suite's files, run on its own runner against its
// own PostgreSQL service — nothing is shared between two shards, so splitting
// a suite never runs two files against one database at the same time.

export const SHARDED_JOBS = {
  api: { name: 'api tests', count: 4 },
  e2e: { name: 'e2e chromium', count: 4 },
  'e2e-webkit': { name: 'e2e webkit', count: 5 },
};

/** `[1, 2, …, count]` — the matrix every sharded job declares. */
export const shardIndexes = (count) => Array.from({ length: count }, (_, i) => i + 1);

/** The display name GitHub gives shard `index` of a sharded job. */
export const shardJobName = (job, index) => `${job.name} (${index}/${job.count})`;

/** Every shard's display name, job by job, in index order. */
export const allShardJobNames = () =>
  Object.values(SHARDED_JOBS).flatMap((job) => shardIndexes(job.count).map((i) => shardJobName(job, i)));

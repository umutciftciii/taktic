// Post-merge gate for the CI workflow.
//
// A pull request's CI run tests the merge commit GitHub builds for it
// (refs/pull/N/merge): the PR head merged into the base branch as it stood at
// that moment. When that PR is then merged and main has not moved in between,
// the commit that lands on main has the very same tree and the very same first
// parent — the push run would test byte-for-byte the code the PR run already
// tested. This gate proves that, and only that, from GitHub's own records. It
// answers `reuse=true` when every link of the chain holds and `reuse=false` for
// anything else — including every error, missing record and unexpected shape —
// so the full suite is what runs whenever there is any doubt.
//
// The PR run records which merge commit it checked out as an artifact named
// `ci-tested-commit-<sha>` (a run's API record carries the PR head, not the
// merge commit it tested). Only the SHA is taken from that name; its tree and
// parents are read back from GitHub.

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// The three jobs that make up a full CI run. A PR run is evidence only when
// each of them ran and succeeded in its latest attempt; a skipped one is not
// evidence. `post-merge-gate.test.mjs` checks these names against ci.yml.
export const REQUIRED_JOBS = [
  'typecheck · lint · test · build',
  'e2e (chromium)',
  'e2e (webkit · sign-in and mobile shells)',
];

export const EVIDENCE_PREFIX = 'ci-tested-commit-';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

const full = (reason) => ({ reuse: false, reason });

/**
 * @param {object} push   what the push event says:
 *   { event, ref, before, after, forced, defaultBranch }
 * @param {object} api    { commit(sha), pullsForCommit(sha), runsForHead(sha),
 *                          jobs(runId), artifacts(runId) } — GitHub REST reads
 * @param {object} [opts] { pr } — local dry run only: evaluate this open PR
 *                          as if it had been merged as `after`
 */
export async function evaluate(push, api, opts = {}) {
  if (push.event !== 'push') return full(`event is ${push.event}, not push`);
  if (push.ref !== `refs/heads/${push.defaultBranch}`) return full(`ref ${push.ref} is not the default branch`);
  if (push.forced) return full('forced push');
  if (!SHA.test(push.before ?? '') || push.before === ZERO_SHA) return full('push has no previous tip');
  if (!SHA.test(push.after ?? '')) return full('push has no new tip');

  const landed = await api.commit(push.after);
  if (landed.parents[0] !== push.before) {
    return full('push added more than one commit or rewrote history (first parent is not the previous tip)');
  }

  let pr;
  if (opts.pr) {
    pr = opts.pr;
  } else {
    const merged = (await api.pullsForCommit(push.after)).filter(
      (p) => p.merged_at && p.merge_commit_sha === push.after && p.base?.ref === push.defaultBranch,
    );
    if (merged.length !== 1) {
      return full(`no single merged pull request produced ${push.after} (direct push?)`);
    }
    pr = merged[0];
  }
  const head = pr.head?.sha;
  if (!SHA.test(head ?? '')) return full(`PR #${pr.number} has no head SHA`);

  const runs = (await api.runsForHead(head)).filter((r) => r.event === 'pull_request' && r.head_sha === head);
  if (runs.length === 0) return full(`no pull_request CI run for PR #${pr.number} head ${head}`);
  const run = runs.reduce((a, b) =>
    a.created_at > b.created_at || (a.created_at === b.created_at && a.run_number > b.run_number) ? a : b,
  );
  const at = `PR #${pr.number} run ${run.id}`;
  if (run.status !== 'completed') return full(`${at} is ${run.status}`);
  if (run.conclusion !== 'success') return full(`${at} concluded ${run.conclusion}`);

  const jobs = await api.jobs(run.id);
  for (const name of REQUIRED_JOBS) {
    const matching = jobs.filter((j) => j.name === name);
    if (matching.length !== 1) return full(`${at} has ${matching.length} jobs named "${name}"`);
    const [job] = matching;
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      return full(`${at} job "${name}" is ${job.status}/${job.conclusion}`);
    }
  }

  const tested = [
    ...new Set(
      (await api.artifacts(run.id))
        .filter((a) => a.name.startsWith(EVIDENCE_PREFIX) && !a.expired)
        .map((a) => a.name.slice(EVIDENCE_PREFIX.length)),
    ),
  ];
  if (tested.length !== 1 || !SHA.test(tested[0])) {
    return full(`${at} does not record exactly one tested merge commit (found ${tested.length})`);
  }

  const testedCommit = await api.commit(tested[0]);
  if (testedCommit.parents[0] !== landed.parents[0]) {
    return full(`${at} tested on top of ${testedCommit.parents[0]}, but ${push.after} landed on ${landed.parents[0]}`);
  }
  if (testedCommit.tree !== landed.tree) {
    return full(`${at} tested tree ${testedCommit.tree}, but ${push.after} has tree ${landed.tree}`);
  }

  return {
    reuse: true,
    reason: `${at} tested ${tested[0]}: same tree ${landed.tree} on the same base ${landed.parents[0]}`,
    pr: pr.number,
    runId: run.id,
    runUrl: run.html_url,
    testedSha: tested[0],
  };
}

export function githubApi({ repo, token, workflowFile }) {
  const get = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return res.json();
  };
  return {
    async commit(sha) {
      const c = await get(`/git/commits/${sha}`);
      return { tree: c.tree.sha, parents: c.parents.map((p) => p.sha) };
    },
    pullsForCommit: (sha) => get(`/commits/${sha}/pulls?per_page=100`),
    async runsForHead(sha) {
      const r = await get(`/actions/workflows/${workflowFile}/runs?event=pull_request&head_sha=${sha}&per_page=100`);
      return r.workflow_runs;
    },
    async jobs(runId) {
      return (await get(`/actions/runs/${runId}/jobs?filter=latest&per_page=100`)).jobs;
    },
    async artifacts(runId) {
      return (await get(`/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
    },
  };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  let push, repo, token, workflowFile, opts = {};

  if (dryRun) {
    // Local evaluation against real GitHub records, for verification only:
    //   node post-merge-gate.mjs --dry-run --repo o/r --after SHA [--before SHA] [--pr N]
    // --pr evaluates an open PR as if merged as --after (normally its
    // merge_commit_sha). The workflow never passes it.
    repo = flag(args, '--repo');
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    workflowFile = flag(args, '--workflow') ?? 'ci.yml';
    const api = githubApi({ repo, token, workflowFile });
    const after = flag(args, '--after');
    const before = flag(args, '--before') ?? (await api.commit(after)).parents[0];
    push = { event: 'push', ref: 'refs/heads/main', defaultBranch: 'main', before, after, forced: false };
    const prNumber = flag(args, '--pr');
    if (prNumber) {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      opts.pr = await res.json();
    }
    const started = Date.now();
    const decision = await evaluate(push, api, opts).catch((e) => full(`gate error: ${e.message}`));
    console.log(JSON.stringify({ ...decision, ms: Date.now() - started }));
    return;
  }

  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  repo = process.env.GITHUB_REPOSITORY;
  token = process.env.GITHUB_TOKEN;
  // GITHUB_WORKFLOW_REF: owner/repo/.github/workflows/ci.yml@refs/heads/main
  workflowFile = basename(process.env.GITHUB_WORKFLOW_REF.split('@')[0]);
  push = {
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    defaultBranch: event.repository?.default_branch,
    before: event.before,
    after: event.after,
    forced: event.forced === true,
  };

  const decision = await evaluate(push, githubApi({ repo, token, workflowFile })).catch((e) =>
    full(`gate error: ${e.message}`),
  );

  appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${decision.reuse}\n`);
  const summary = decision.reuse
    ? [
        '### Full CI not repeated for this push',
        '',
        `${decision.reason}.`,
        '',
        `The three CI jobs are **skipped** here, not passed: their result for this exact tree is [PR #${decision.pr}, run ${decision.runId}](${decision.runUrl}).`,
      ]
    : ['### Full CI runs for this push', '', `No reusable PR result: ${decision.reason}.`];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  console.log(`reuse=${decision.reuse}: ${decision.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Never fail the gate: an empty or false output makes the full suite run.
    console.log(`::warning::post-merge gate error, running full CI: ${e.message}`);
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, 'reuse=false\n');
    } catch {}
  });
}

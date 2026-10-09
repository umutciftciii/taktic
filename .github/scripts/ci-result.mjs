// CI result: the one check branch protection requires (CI-PROTECT-001).
//
// Required checks are matched by name, and GitHub counts a *skipped* check as
// a passing one. Every job in ci.yml is skipped somewhere on purpose — the
// post-merge gate on every pull request, the full jobs on a push whose PR run
// is reused — so requiring those names directly would let a run that never
// tested anything satisfy the rule. This job runs always (`if: always()`),
// whatever happened above it, and is the only place that decides what "CI
// passed" means for each event:
//
//   pull_request  the evidence job and every full job ran and succeeded on
//                 this exact head — a skipped, cancelled or failed one fails
//   push (main)   the post-merge gate succeeded, and then either it proved
//                 reuse and the full jobs were skipped for exactly that
//                 reason, or it did not and every full job ran and succeeded
//
// Anything else — another event, a missing job, an unexpected result — fails.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Job ids (not display names) as `needs` reports them.
export const FULL_JOBS = ['verify', 'e2e', 'e2e-webkit', 'ops'];
export const PR_JOBS = ['pr-evidence', ...FULL_JOBS];
export const GATE_JOB = 'post-merge-gate';

const fail = (reason) => ({ ok: false, reason });

/**
 * @param {string} event  github.event_name
 * @param {Record<string, { result?: string, outputs?: Record<string, string> }>} needs  toJSON(needs)
 */
export function decide(event, needs) {
  if (!needs || typeof needs !== 'object') return fail('no job results');
  const result = (id) => needs[id]?.result ?? 'missing';
  const notSucceeded = (ids) => ids.filter((id) => result(id) !== 'success');

  if (event === 'pull_request') {
    const bad = notSucceeded(PR_JOBS);
    if (bad.length > 0) return fail(`not succeeded on this head: ${bad.map((id) => `${id}=${result(id)}`).join(', ')}`);
    return { ok: true, reason: `${PR_JOBS.join(', ')} succeeded on this head` };
  }

  if (event === 'push') {
    if (result(GATE_JOB) !== 'success') return fail(`${GATE_JOB}=${result(GATE_JOB)}`);
    if (needs[GATE_JOB]?.outputs?.reuse === 'true') {
      const ran = FULL_JOBS.filter((id) => result(id) !== 'skipped');
      if (ran.length > 0) {
        return fail(`gate proved reuse, but ${ran.map((id) => `${id}=${result(id)}`).join(', ')} did not skip`);
      }
      return { ok: true, reason: 'the gate proved this tree identical to its PR run; full jobs reused, not re-run' };
    }
    const bad = notSucceeded(FULL_JOBS);
    if (bad.length > 0) return fail(`no reuse, and ${bad.map((id) => `${id}=${result(id)}`).join(', ')}`);
    return { ok: true, reason: `no reuse; ${FULL_JOBS.join(', ')} ran and succeeded` };
  }

  return fail(`event ${event} has no CI result rule`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let decision;
  try {
    decision = decide(process.env.EVENT, JSON.parse(process.env.NEEDS ?? 'null'));
  } catch (error) {
    decision = fail(`could not read job results: ${error.message}`);
  }
  const line = `${decision.ok ? 'CI passed' : 'CI failed'}: ${decision.reason}`;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
  } catch {}
  console.log(decision.ok ? line : `::error::${line}`);
  process.exitCode = decision.ok ? 0 : 1;
}

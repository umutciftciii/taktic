// Confirms that main's Actions cache holds an entry the job just saved
// (CI-PERF-002B).
//
// actions/cache/save reports a failed upload as a warning and succeeds, so the
// cache-warming job has to look for the entry itself. Looking right after the
// save is not enough: on main (run 41502413097) a lookup-only restore 0.25 s
// after "Cache saved with key …" found nothing, while the entry was listed by
// the API moments later. So this asks the REST API — the list the cache
// service keeps per ref — several times over a bounded window, and only an
// entry still absent at the end is reported as not saved. An API error counts
// as "not seen yet" until the last attempt; it is never read as found.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} o
 * @param {string} o.key    the exact key actions/cache/save stored
 * @param {string} o.ref    the ref whose scope holds it (refs/heads/main)
 * @param {(key: string, ref: string) => Promise<Array<{ key: string, ref: string }>>} o.list
 * @param {number} [o.attempts]
 * @param {number} [o.delayMs]  between attempts
 * @param {(ms: number) => Promise<void>} [o.wait]
 * @returns {Promise<{ ok: boolean, attempts: number, reason: string }>}
 */
export async function confirm({ key, ref, list, attempts = 7, delayMs = 10_000, wait = sleep }) {
  if (!key || !ref) return { ok: false, attempts: 0, reason: 'no key or ref to look for' };
  let last = 'not listed';
  for (let n = 1; n <= attempts; n++) {
    try {
      // `key` filters by prefix, so the match must be exact.
      const entries = await list(key, ref);
      if (entries.some((e) => e.key === key && e.ref === ref)) {
        return { ok: true, attempts: n, reason: `listed for ${ref} on attempt ${n}` };
      }
      last = 'not listed';
    } catch (error) {
      last = `API error: ${error.message}`;
    }
    if (n < attempts) await wait(delayMs);
  }
  const waited = Math.round(((attempts - 1) * delayMs) / 1000);
  return { ok: false, attempts, reason: `${key} not listed for ${ref} after ${attempts} attempts over ${waited}s (last: ${last})` };
}

async function listCaches(key, ref) {
  const url = new URL(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}/actions/caches`);
  url.searchParams.set('key', key);
  url.searchParams.set('ref', ref);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).actions_caches ?? [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await confirm({ key: process.env.KEY, ref: process.env.REF, list: listCaches });
  const line = result.ok ? `cache entry confirmed: ${result.reason}` : `cache entry not confirmed: ${result.reason}`;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.ok ? '✅' : '⚠️'} ${line}\n`);
  } catch {}
  console.log(result.ok ? line : `::warning::${line}`);
  process.exitCode = result.ok ? 0 : 1;
}

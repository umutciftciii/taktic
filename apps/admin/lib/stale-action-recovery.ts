'use client';

import { unstable_isUnrecognizedActionError } from 'next/navigation';

/**
 * One reload, and only for the one error a reload actually fixes.
 *
 * A Server Action is addressed by an id baked into the page that rendered the
 * form. `next dev` derives a fresh set of ids on every compile, so a tab left
 * open across a restart or a hot rebuild posts an id the new process has never
 * heard of; Next answers 404 with `x-nextjs-action-not-found`, the client throws
 * `UnrecognizedActionError`, and — because a form `action={…}` has no catch
 * around it — the nearest error boundary renders "Bir şeyler ters gitti". That
 * is what the reported screens were: a stale tab, not a broken route. In a
 * production build the ids are a deterministic function of the source, so the
 * same tab keeps working across restarts and across rebuilds of unchanged code,
 * and this path is never taken.
 *
 * The recovery is a plain page load, which fetches the current ids. It is
 * deliberately not a retry: the submission is not replayed, nothing is
 * re-posted, and an action that had already reached the server is not run
 * twice. The boundary still logs the error and still renders — if the reload is
 * refused or fails, the operator sees exactly what they saw before.
 *
 * Loop safety is layered:
 *   1. Only `UnrecognizedActionError` qualifies. Every other failure renders.
 *   2. A reload alone cannot produce another one: a Server Action fires from a
 *      submit, and reloading submits nothing.
 *   3. The attempt is stamped in `sessionStorage`, and a second attempt inside
 *      the cooldown is refused. If storage is unavailable, nothing reloads —
 *      an unverifiable "have I already tried?" is answered "yes".
 */
const ATTEMPT_KEY = 'taktick-admin:stale-action-reload';

/**
 * Long enough that a reload-loop would have to be slower than a person clicking
 * "Tekrar dene", short enough that a second, genuinely separate rebuild later in
 * the same tab still recovers on its own.
 */
export const STALE_ACTION_RELOAD_COOLDOWN_MS = 10_000;

export type StaleActionDecision = 'reload' | 'render';

/**
 * The whole decision, with no browser globals in it.
 *
 * `now` and `lastAttempt` are passed in so the rule can be stated — and tested
 * — as what it is: at most one reload per cooldown, and only for this error.
 */
export function decideStaleActionRecovery(
  isStaleAction: boolean,
  lastAttempt: number | null,
  now: number,
): StaleActionDecision {
  if (!isStaleAction) {
    return 'render';
  }

  if (lastAttempt !== null && now - lastAttempt < STALE_ACTION_RELOAD_COOLDOWN_MS) {
    return 'render';
  }

  return 'reload';
}

/**
 * Applies the decision in the browser. Returns true when a reload was started,
 * so a caller can tell "recovering" from "this is a real error screen".
 */
export function recoverFromStaleAction(error: unknown): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const isStaleAction = unstable_isUnrecognizedActionError(error);

  let lastAttempt: number | null;
  try {
    const raw = window.sessionStorage.getItem(ATTEMPT_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    lastAttempt = Number.isFinite(parsed) ? parsed : null;
  } catch {
    // No session storage — a private window, a locked-down profile. Without a
    // record of the previous attempt there is no way to bound the next one, so
    // the screen stays put.
    return false;
  }

  const now = Date.now();
  if (decideStaleActionRecovery(isStaleAction, lastAttempt, now) === 'render') {
    return false;
  }

  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, String(now));
  } catch {
    return false;
  }

  window.location.reload();
  return true;
}

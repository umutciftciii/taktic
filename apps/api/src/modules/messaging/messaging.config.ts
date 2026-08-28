/**
 * The limits messaging runs under.
 *
 * All three are read per call rather than captured at import time, so a test
 * and a deployment see the environment they actually have.
 */

/**
 * The longest a message may be.
 *
 * Two thousand characters is several paragraphs — enough to describe a job, and
 * far short of a size at which storing, listing or rendering a conversation
 * becomes a different problem.
 */
export const MESSAGE_BODY_MAX_LENGTH = 2000;

/** How many messages one page of history carries by default. */
export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;

/** And the most a caller may ask for, so a page cannot become "all of them". */
export const MESSAGE_PAGE_MAX_LIMIT = 100;

/** Refusal code for a caller that is writing faster than the limit allows. */
export const MESSAGE_RATE_LIMITED_CODE = 'MESSAGE_RATE_LIMITED';

const DEFAULT_RATE_LIMIT_MAX = 10;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * How many messages one account may send in the window below.
 *
 * Deliberately generous for a person and useless for a script: a real
 * conversation never reaches ten messages a minute, and a loop reaches it
 * immediately. The counter is the `Message` table itself — no in-memory state,
 * so the limit survives a restart and holds across every process behind a load
 * balancer.
 */
export function messageRateLimitMax(): number {
  return readPositiveInt('MESSAGE_RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX);
}

export function messageRateLimitWindowSeconds(): number {
  return readPositiveInt('MESSAGE_RATE_LIMIT_WINDOW_SECONDS', DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number (received "${raw}")`);
  }

  return parsed;
}

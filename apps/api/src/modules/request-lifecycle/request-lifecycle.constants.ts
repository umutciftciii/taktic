import { validateCronExpression } from 'cron';

/**
 * Timing and configuration for the approved-request lifecycle jobs.
 *
 * Two product rules live here and nowhere else:
 *
 *  - an APPROVED request stays open for 14 days from its approval moment;
 *  - on day 7, a request that still has no offer at all earns one reminder.
 *
 * Both are measured from ServiceRequest.approvedAt — never from submittedAt or
 * moderatedAt. A request approved before that column existed carries NULL and
 * is deliberately invisible to both jobs.
 */

/** How long an APPROVED request stays open before the expiry job closes it. */
export const REQUEST_EXPIRY_DAYS = 14;

/** How long an offer-less APPROVED request waits before the single reminder. */
export const REQUEST_REMINDER_AFTER_DAYS = 7;

/** Requests one scheduler run may touch, and the ceiling on the env override. */
export const DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT = 200;
export const MAX_REQUEST_LIFECYCLE_SCAN_LIMIT = 1000;

const DEFAULT_EXPIRY_CRON = '15 * * * *';
const DEFAULT_REMINDER_CRON = '45 * * * *';

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function requestExpiryCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REQUEST_EXPIRY_DAYS * DAY_IN_MS);
}

export function requestReminderCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REQUEST_REMINDER_AFTER_DAYS * DAY_IN_MS);
}

/**
 * Both jobs are off unless the deployment says otherwise.
 *
 * Off is the safe default because these are the only two writers that close a
 * request or mail a customer without a human in the loop: a half-configured
 * environment must do nothing rather than expire live requests. Only the two
 * literals are accepted, so a typo fails at boot instead of silently disabling
 * a job that the operator believes is running.
 */
export function isRequestExpirySchedulerEnabled(): boolean {
  return readStrictBoolean('REQUEST_EXPIRY_SCHEDULER_ENABLED', false);
}

export function isRequestReminderSchedulerEnabled(): boolean {
  return readStrictBoolean('REQUEST_REMINDER_SCHEDULER_ENABLED', false);
}

export function readRequestExpiryCron(): string {
  return readCron('REQUEST_EXPIRY_SCHEDULER_CRON', DEFAULT_EXPIRY_CRON);
}

export function readRequestReminderCron(): string {
  return readCron('REQUEST_REMINDER_SCHEDULER_CRON', DEFAULT_REMINDER_CRON);
}

export function readRequestLifecycleScanLimit(): number {
  const raw = process.env.REQUEST_LIFECYCLE_SCAN_LIMIT?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REQUEST_LIFECYCLE_SCAN_LIMIT) {
    throw new Error(
      `REQUEST_LIFECYCLE_SCAN_LIMIT must be an integer between 1 and ${MAX_REQUEST_LIFECYCLE_SCAN_LIMIT} (received "${raw}")`,
    );
  }

  return parsed;
}

/**
 * An unreadable cron expression is a configuration error, not a reason to fall
 * back: a job silently running on a default schedule the operator never chose
 * is worse than a boot that refuses to start.
 */
function readCron(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const result = validateCronExpression(raw);
  if (!result.valid) {
    throw new Error(`${name} is not a valid cron expression (received "${raw}")`);
  }

  return raw;
}

function readStrictBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error(`${name} must be exactly "true" or "false" (received "${raw}")`);
}

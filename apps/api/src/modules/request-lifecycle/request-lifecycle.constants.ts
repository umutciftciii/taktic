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
 *
 * What is deliberately *not* here any more is whether either job runs. That was
 * a pair of environment flags; it is now a persistent operations setting a
 * super admin maintains, read on every tick — see SchedulerSettingsService. The
 * cron expressions moved to common/scheduler-cron.ts, where all four jobs'
 * schedules are read the same way.
 */

/** How long an APPROVED request stays open before the expiry job closes it. */
export const REQUEST_EXPIRY_DAYS = 14;

/** How long an offer-less APPROVED request waits before the single reminder. */
export const REQUEST_REMINDER_AFTER_DAYS = 7;

/** Requests one scheduler run may touch, and the ceiling on the env override. */
export const DEFAULT_REQUEST_LIFECYCLE_SCAN_LIMIT = 200;
export const MAX_REQUEST_LIFECYCLE_SCAN_LIMIT = 1000;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function requestExpiryCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REQUEST_EXPIRY_DAYS * DAY_IN_MS);
}

export function requestReminderCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - REQUEST_REMINDER_AFTER_DAYS * DAY_IN_MS);
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

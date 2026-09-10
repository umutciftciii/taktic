import { validateCronExpression } from 'cron';
import { SCHEDULER_JOB_KEYS, SchedulerJobKey } from '../modules/operations-settings/scheduler-jobs';

/**
 * When each background job wakes up.
 *
 * The split this module exists to hold: **when a job ticks is deployment
 * configuration; whether it does anything is an operations setting.** The
 * second half moved to the database and to a super admin's screen. This half
 * did not, and must not — a cron expression decides load, and an operator who
 * can retype one from a browser can turn an hourly pass into a per-minute one
 * against a live database. It stays where a deploy puts it.
 *
 * Gathered here rather than one reader per scheduler file because the admin
 * screen shows all four, read-only, next to the switch it does control. Three
 * copies of "read an env var, validate it, fall back" were already three
 * slightly different copies: one threw on a bad value, one silently used its
 * default. They behave the same way now, and it is the strict one that won —
 * see {@link readCron}.
 *
 * Read on every call rather than cached at import, like every other
 * configuration switch in this codebase, so a test sees the environment it has.
 * The `@Cron()` decorators are the one exception by construction: a decorator
 * needs its expression before any instance exists, so the four scheduler files
 * evaluate theirs at import time. That is also what turns a malformed
 * expression into a boot failure rather than a job quietly running on a
 * schedule nobody chose.
 */

/** One job's environment variable and the schedule it falls back to. */
type CronConfig = { variable: string; fallback: string };

export const SCHEDULER_CRON_CONFIG = {
  'entitlement-renewal': { variable: 'ENTITLEMENT_RENEWAL_CRON', fallback: '*/15 * * * *' },
  'unviewed-offer-refund': { variable: 'UNVIEWED_OFFER_REFUND_CRON', fallback: '0 * * * *' },
  'request-expiry': { variable: 'REQUEST_EXPIRY_SCHEDULER_CRON', fallback: '15 * * * *' },
  'request-reminder': { variable: 'REQUEST_REMINDER_SCHEDULER_CRON', fallback: '45 * * * *' },
  // Every five minutes, and deliberately the tightest schedule of the six. An
  // urgent lead promises an answer in three hours; a sweeper that woke hourly
  // could add most of an hour to a deadline the customer was shown to the
  // minute, and "we told you three hours and asked you at four" is not a
  // promise kept.
  'showcase-lead-sla': { variable: 'SHOWCASE_LEAD_SLA_CRON', fallback: '*/5 * * * *' },
  // Twice a day is plenty: nothing depends on this having run, because every
  // publish path checks the window itself.
  'showcase-placement-expiry': {
    variable: 'SHOWCASE_PLACEMENT_EXPIRY_CRON',
    fallback: '20 3,15 * * *',
  },
} as const satisfies Record<SchedulerJobKey, CronConfig>;

export function readSchedulerCron(job: SchedulerJobKey): string {
  const { variable, fallback } = SCHEDULER_CRON_CONFIG[job];
  return readCron(variable, fallback);
}

/** Every job's expression, for the admin screen's read-only column. */
export function readSchedulerCrons(): Record<SchedulerJobKey, string> {
  return Object.fromEntries(
    SCHEDULER_JOB_KEYS.map((job) => [job, readSchedulerCron(job)]),
  ) as Record<SchedulerJobKey, string>;
}

/**
 * An unreadable cron expression is a configuration error, not a reason to fall
 * back: a job silently running on a default schedule the operator never chose
 * is worse than a boot that refuses to start.
 *
 * The value itself is never echoed. These expressions are read at import time,
 * so the message surfaces in a boot log; naming the variable is what an
 * operator needs, and quoting whatever was actually in it is how a pasted
 * secret ends up in a log line.
 */
function readCron(variable: string, fallback: string): string {
  const raw = process.env[variable]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (!validateCronExpression(raw).valid) {
    throw new Error(
      `${variable} is not a valid cron expression. The value itself is deliberately not shown.`,
    );
  }

  return raw;
}

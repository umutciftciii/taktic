import { CronTime } from 'cron';

/**
 * ADMIN-SYSTEM-HEALTH-001: the rules that turn what was measured into a state.
 *
 * Pure functions, kept apart from the service that gathers the facts, so every
 * threshold below is pinned by a unit test rather than by a database fixture.
 *
 * Four states and no fifth. The one rule every function here keeps is that
 * **HEALTHY is a measurement, never a default**: a source that was not
 * measured, could not be measured, or measured nothing (no run, no mail) is
 * UNKNOWN, and UNKNOWN outranks HEALTHY when states are combined — a section
 * with one unmeasured member is not a healthy section.
 */
export const HEALTH_STATUSES = ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Worst first: DOWN > DEGRADED > UNKNOWN > HEALTHY. */
const SEVERITY: Record<HealthStatus, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

/**
 * The combined state of several measurements: the worst of them. Nothing to
 * combine is UNKNOWN — an empty list is not evidence of health.
 */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'UNKNOWN';
  return statuses.reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst));
}

/**
 * ADMIN-SYSTEM-HEALTH-002: the overall state, by what kind of thing failed.
 *
 * The core services — API, PostgreSQL, web, admin — are what a person needs
 * to use the product; only they can make the whole system DOWN. Background
 * work (scheduled jobs, e-mail) failing or running late is a real problem, but
 * the system still serves people while it lasts, so a background section
 * lifts the overall state to DEGRADED at most. Its own section and rows keep
 * their real state: a job three ticks late still reads DOWN on its own row.
 *
 * UNKNOWN is untouched by the cap and still outranks HEALTHY — an unmeasured
 * background section keeps the overall state from claiming health.
 */
export function capBackgroundStatus(status: HealthStatus): HealthStatus {
  return status === 'DOWN' ? 'DEGRADED' : status;
}

export function overallStatus(core: readonly HealthStatus[], background: readonly HealthStatus[]): HealthStatus {
  return worstStatus([...core, ...background.map(capBackgroundStatus)]);
}

// ---------------------------------------------------------------------------
// Internal HTTP probes (web, admin)
// ---------------------------------------------------------------------------

/** Each probe gets this long, then it is DOWN. */
export const PROBE_TIMEOUT_MS = 1_500;
/** An answer slower than this is DEGRADED even when it is the right answer. */
export const PROBE_SLOW_MS = 1_000;

/**
 * The two services probed, each with the one path and the one status that
 * count as "up" — the same requests their container HEALTHCHECKs make
 * (Dockerfile): the web's robots.txt, and the panel's sign-in page, which is
 * public and so answers 200 to a caller without a session. A redirect from
 * either is not success: robots.txt never redirects, and a sign-in page that
 * redirects a caller with no cookie is not the page the probe asked for.
 *
 * The address comes from the deployment's environment and nowhere else — no
 * request parameter, header or stored value reaches it — so this endpoint
 * cannot be pointed at an arbitrary host.
 */
export const INTERNAL_PROBES = {
  web: { variable: 'WEB_INTERNAL_URL', path: '/robots.txt', expectedStatus: 200 },
  admin: { variable: 'ADMIN_INTERNAL_URL', path: '/login', expectedStatus: 200 },
} as const;

export type ProbeTarget = keyof typeof INTERNAL_PROBES;

export type ProbeTargetResolution =
  | { configured: true; url: URL }
  | { configured: false; reason: 'NOT_CONFIGURED' | 'MISCONFIGURED' };

/**
 * The probe address, if the deployment named a usable one: an http(s) origin
 * with no credentials, path, query or fragment. Anything else is not guessed
 * at — it is MISCONFIGURED, and the service is UNKNOWN. The value itself is
 * never echoed into a response or a log line.
 */
export function resolveProbeTarget(target: ProbeTarget, env: NodeJS.ProcessEnv = process.env): ProbeTargetResolution {
  const { variable, path } = INTERNAL_PROBES[target];
  const raw = env[variable]?.trim();
  if (!raw) return { configured: false, reason: 'NOT_CONFIGURED' };

  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return { configured: false, reason: 'MISCONFIGURED' };
  }
  const isOrigin =
    (origin.protocol === 'http:' || origin.protocol === 'https:') &&
    origin.username === '' &&
    origin.password === '' &&
    origin.search === '' &&
    origin.hash === '' &&
    (origin.pathname === '' || origin.pathname === '/');
  if (!isOrigin) return { configured: false, reason: 'MISCONFIGURED' };

  return { configured: true, url: new URL(path, origin.origin) };
}

export type ProbeOutcome =
  | { kind: 'response'; status: number; latencyMs: number }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'error'; latencyMs: number };

export type ProbeReason =
  | 'OK'
  | 'SLOW'
  | 'UNEXPECTED_REDIRECT'
  | 'UNEXPECTED_STATUS'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'NOT_CONFIGURED'
  | 'MISCONFIGURED';

/**
 * One probe's answer as a state:
 *
 *   expected status, fast        HEALTHY
 *   expected status, > 1 s       DEGRADED (SLOW)
 *   3xx                          DEGRADED (UNEXPECTED_REDIRECT)
 *   any other 1xx/2xx/4xx        DEGRADED (UNEXPECTED_STATUS) — it answers, not as it should
 *   5xx                          DOWN (SERVER_ERROR)
 *   no answer in 1.5 s           DOWN (TIMEOUT)
 *   connection refused / DNS     DOWN (UNREACHABLE)
 */
export function evaluateProbe(
  outcome: ProbeOutcome,
  expectedStatus: number,
): { status: HealthStatus; reason: ProbeReason } {
  if (outcome.kind === 'timeout') return { status: 'DOWN', reason: 'TIMEOUT' };
  if (outcome.kind === 'error') return { status: 'DOWN', reason: 'UNREACHABLE' };
  const code = outcome.status;
  if (code === expectedStatus) {
    return outcome.latencyMs > PROBE_SLOW_MS ? { status: 'DEGRADED', reason: 'SLOW' } : { status: 'HEALTHY', reason: 'OK' };
  }
  if (code >= 500) return { status: 'DOWN', reason: 'SERVER_ERROR' };
  if (code >= 300 && code < 400) return { status: 'DEGRADED', reason: 'UNEXPECTED_REDIRECT' };
  return { status: 'DEGRADED', reason: 'UNEXPECTED_STATUS' };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type DatabaseReason = 'OK' | 'SLOW' | 'TIMEOUT' | 'UNREACHABLE';

/** The readiness probe's answer as a state; a slow "ok" is DEGRADED. */
export function evaluateDatabase(
  database: 'ok' | 'timeout' | 'unreachable',
  latencyMs: number,
): { status: HealthStatus; reason: DatabaseReason } {
  if (database === 'timeout') return { status: 'DOWN', reason: 'TIMEOUT' };
  if (database === 'unreachable') return { status: 'DOWN', reason: 'UNREACHABLE' };
  return latencyMs > PROBE_SLOW_MS ? { status: 'DEGRADED', reason: 'SLOW' } : { status: 'HEALTHY', reason: 'OK' };
}

// ---------------------------------------------------------------------------
// Schedulers
// ---------------------------------------------------------------------------

/**
 * How long after its scheduled moment a tick may still be on its way before
 * it counts as missed: a run's lease (scheduler-run-registry) is five
 * minutes, and a tick that has not started a run in that long did not run.
 */
export const SCHEDULER_TICK_GRACE_MS = 5 * 60_000;
/** Missed ticks at which an overdue job is DOWN rather than DEGRADED. */
export const SCHEDULER_MISSED_TICKS_DOWN = 3;
/** Consecutive failures (no success in between) at which a job is DOWN. */
export const SCHEDULER_FAILURES_DOWN = 3;

export type SchedulerReason =
  | 'DISABLED'
  | 'NO_RECORDED_RUN'
  | 'RUNNING'
  | 'LAST_RUN_SUCCEEDED'
  | 'LAST_RUN_FAILED'
  | 'LAST_RUN_INTERRUPTED'
  | 'REPEATED_FAILURES'
  | 'OVERDUE';

/**
 * How many of the job's scheduled ticks fell after `since` and are past their
 * grace — i.e. should have started a run by `now` and did not. Capped at
 * {@link SCHEDULER_MISSED_TICKS_DOWN}: past that the answer is the same.
 *
 * The expression is read in the process's own time zone, as the `@Cron()`
 * decorators that run the jobs read it (none of them names one).
 */
export function countMissedTicks(cron: string, since: Date, now: Date): number {
  const deadline = now.getTime() - SCHEDULER_TICK_GRACE_MS;
  const time = new CronTime(cron);
  let cursor = since;
  let missed = 0;
  while (missed < SCHEDULER_MISSED_TICKS_DOWN) {
    const next = time.getNextDateFrom(cursor).toJSDate();
    if (next.getTime() >= deadline) break;
    missed += 1;
    cursor = next;
  }
  return missed;
}

export type SchedulerRunFacts = {
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  startedAt: Date;
  errorCode: string | null;
};

export type SchedulerJobFacts = {
  enabled: boolean;
  cron: string;
  /** The latest SCHEDULER run, or null when none was ever recorded. */
  lastRun: SchedulerRunFacts | null;
  /** When the job was last switched on, if the change history says. */
  enabledSince: Date | null;
  /** Failures since the last success (capped by what was read). */
  failuresSinceLastSuccess: number;
};

/**
 * One job's state. A switched-off job is not measured (UNKNOWN, DISABLED) and
 * is left out of the section's state by the caller: off is a configuration,
 * not a fault. For a switched-on job, in order:
 *
 *   no recorded run                         UNKNOWN (NO_RECORDED_RUN)
 *   a run is open (its lease is live)       HEALTHY (RUNNING)
 *   ≥ 3 ticks missed since the last start   DOWN (OVERDUE)
 *   1–2 ticks missed                        DEGRADED (OVERDUE)
 *   ≥ 3 failures since the last success     DOWN (REPEATED_FAILURES)
 *   last run interrupted                    DEGRADED (LAST_RUN_INTERRUPTED)
 *   last run failed                         DEGRADED (LAST_RUN_FAILED)
 *   last run succeeded, on time             HEALTHY
 *
 * Missed ticks are counted from the later of the last run's start and the
 * moment the job was last switched on, so a job switched on a minute ago is
 * not overdue for the weeks it spent switched off.
 */
export function evaluateSchedulerJob(
  facts: SchedulerJobFacts,
  now: Date,
): { status: HealthStatus; reason: SchedulerReason; missedTicks: number } {
  if (!facts.enabled) return { status: 'UNKNOWN', reason: 'DISABLED', missedTicks: 0 };
  if (!facts.lastRun) {
    // Never ran: overdue if ticks passed since it was switched on, otherwise
    // there is nothing to judge yet.
    const missedTicks = facts.enabledSince ? countMissedTicks(facts.cron, facts.enabledSince, now) : 0;
    if (missedTicks >= SCHEDULER_MISSED_TICKS_DOWN) return { status: 'DOWN', reason: 'OVERDUE', missedTicks };
    if (missedTicks > 0) return { status: 'DEGRADED', reason: 'OVERDUE', missedTicks };
    return { status: 'UNKNOWN', reason: 'NO_RECORDED_RUN', missedTicks: 0 };
  }
  if (facts.lastRun.status === 'RUNNING') return { status: 'HEALTHY', reason: 'RUNNING', missedTicks: 0 };

  const since =
    facts.enabledSince && facts.enabledSince > facts.lastRun.startedAt ? facts.enabledSince : facts.lastRun.startedAt;
  const missedTicks = countMissedTicks(facts.cron, since, now);
  if (missedTicks >= SCHEDULER_MISSED_TICKS_DOWN) return { status: 'DOWN', reason: 'OVERDUE', missedTicks };
  if (missedTicks > 0) return { status: 'DEGRADED', reason: 'OVERDUE', missedTicks };

  if (facts.lastRun.status === 'FAILED') {
    if (facts.failuresSinceLastSuccess >= SCHEDULER_FAILURES_DOWN) {
      return { status: 'DOWN', reason: 'REPEATED_FAILURES', missedTicks };
    }
    return {
      status: 'DEGRADED',
      reason: facts.lastRun.errorCode === 'PROCESS_INTERRUPTED' ? 'LAST_RUN_INTERRUPTED' : 'LAST_RUN_FAILED',
      missedTicks,
    };
  }
  return { status: 'HEALTHY', reason: 'LAST_RUN_SUCCEEDED', missedTicks };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** The window the e-mail counts cover. */
export const EMAIL_WINDOW_MS = 24 * 60 * 60_000;
/** A PENDING message whose last claim is older than this is stuck. */
export const EMAIL_STUCK_PENDING_MS = 15 * 60_000;
/** Failure share (of finished attempts) at which e-mail is DEGRADED. */
export const EMAIL_DEGRADED_FAILURE_RATE = 0.1;
/** Failure share at which e-mail is DOWN — with at least this many failures. */
export const EMAIL_DOWN_FAILURE_RATE = 0.5;
export const EMAIL_DOWN_MIN_FAILURES = 3;

export type EmailReason = 'OK' | 'NO_TRAFFIC' | 'FAILURES' | 'MOSTLY_FAILING' | 'STUCK_PENDING';

export type EmailCounts = { sent: number; failed: number; pending: number; stuckPending: number };

/**
 * The e-mail channel's state over the window:
 *
 *   ≥ 3 failures and ≥ 50 % of finished attempts failed   DOWN (MOSTLY_FAILING)
 *   ≥ 10 % failed                                         DEGRADED (FAILURES)
 *   a PENDING message older than 15 minutes               DEGRADED (STUCK_PENDING)
 *   something was sent                                    HEALTHY
 *   nothing finished in the window                        UNKNOWN (NO_TRAFFIC)
 *
 * No traffic is not health: a channel that sent nothing has shown nothing.
 */
export function evaluateEmail(counts: EmailCounts): { status: HealthStatus; reason: EmailReason } {
  const finished = counts.sent + counts.failed;
  const failureRate = finished === 0 ? 0 : counts.failed / finished;
  if (counts.failed >= EMAIL_DOWN_MIN_FAILURES && failureRate >= EMAIL_DOWN_FAILURE_RATE) {
    return { status: 'DOWN', reason: 'MOSTLY_FAILING' };
  }
  if (counts.failed > 0 && failureRate >= EMAIL_DEGRADED_FAILURE_RATE) return { status: 'DEGRADED', reason: 'FAILURES' };
  if (counts.stuckPending > 0) return { status: 'DEGRADED', reason: 'STUCK_PENDING' };
  if (counts.sent > 0) return { status: 'HEALTHY', reason: 'OK' };
  return { status: 'UNKNOWN', reason: 'NO_TRAFFIC' };
}

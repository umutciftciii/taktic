import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  NotificationChannel,
  NotificationStatus,
  OpsAlertChannel,
  OpsAlertDeliveryStatus,
  OpsAlertNoticeKind,
  OpsAlertSeverity,
  OpsAlertSource,
  OpsAlertState,
  Prisma,
} from '@prisma/client';
import { readOpsAlertCron } from '../../common/scheduler-cron';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationErrorCode, normalizeStoredErrorCode } from '../notifications/notification-errors';
import { SystemHealthService } from '../system-health/system-health.service';
import { OpsAlertConfig, readOpsAlertConfigSafely } from './ops-alert.config';
import { OpsAlertDeliveryWorker } from './ops-alert-delivery.worker';
import {
  EMAIL_CURSOR_SETTLE_MS,
  EMAIL_FAILURE_LOOKBACK_MS,
  EMAIL_INITIAL_LOOKBACK_MS,
  EMAIL_RECOVERY_QUIET_MS,
  OPS_ALERT_ADVISORY_LOCK_KEY,
  OPS_ALERT_ENGINE_STATE_ID,
  OpsAlertCondition,
  OpsAlertResolution,
  alertFingerprint,
  emailRecovered,
  emailSeverity,
  isAlertableEmailCode,
  mergeTemplates,
  newAlertRef,
  noticeChannels,
  reminderDue,
  schedulerDecision,
} from './ops-alert.rules';

type Tx = Prisma.TransactionClient;

type OpenAlert = {
  id: string;
  fingerprint: string;
  source: OpsAlertSource;
  subjectKey: string;
  condition: string;
  severity: OpsAlertSeverity;
  lastSeenAt: Date;
  lastNotifiedAt: Date;
  occurrenceCount: number;
  reminderCount: number;
  detail: Prisma.JsonValue;
};

const openAlertSelect = {
  id: true,
  fingerprint: true,
  source: true,
  subjectKey: true,
  condition: true,
  severity: true,
  lastSeenAt: true,
  lastNotifiedAt: true,
  occurrenceCount: true,
  reminderCount: true,
  detail: true,
} as const;

/** One problem as the evaluator saw it on this tick. */
type Observation = {
  source: OpsAlertSource;
  subjectKey: string;
  condition: OpsAlertCondition;
  severity: (occurrences: number) => OpsAlertSeverity;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /**
   * How this tick changes the count. `key`: one occurrence per distinct key
   * (a failed run); `add`: n new occurrences (failed e-mails since the
   * cursor); `atLeast`: a level (missed ticks).
   */
  occurrence: { key: string } | { add: number } | { atLeast: number };
  detail: Record<string, unknown>;
};

export type EvaluationOutcome = 'EVALUATED' | 'BUSY' | 'FAILED';

/**
 * OBS-ALERT-001 — the operations alert evaluator.
 *
 * Every {@link readOpsAlertCron} tick (five minutes) it reads two things and
 * nothing else:
 *
 * - **Scheduled jobs**, through the system health screen's own reader and
 *   rules (`SystemHealthService.readSchedulerFacts` → evaluateSchedulerJob):
 *   a failed last run, a run that never came (OVERDUE, by the same missed-tick
 *   rule), and recovery. A switched-off job never alerts; a job that has not
 *   yet reached its first tick is not judged. Index probes per job.
 * - **Failed e-mails** since the last tick's cursor, grouped by error class,
 *   over `(status, createdAt)` bounded to a day — never a scan of the log.
 *
 * It then opens, updates, reminds and resolves alerts, and queues one
 * delivery per notice per channel — all in one transaction holding
 * `pg_try_advisory_xact_lock`, so a second evaluator (another instance, a
 * slow previous tick) finds the lock taken and does nothing. The partial
 * unique index on an OPEN fingerprint backs that up in the database itself.
 *
 * Restarts lose nothing: every alert, notice and the cursor are rows, and the
 * next tick continues from them.
 *
 * Its own failure is logged by class and written to the engine state row —
 * which the health screen reads — and never becomes an alert, a SchedulerRun
 * row or a NotificationLog row: there is no path from this engine's trouble
 * back into its inputs. Nothing it does touches the jobs or messages it
 * watches.
 */
@Injectable()
export class OpsAlertEvaluator {
  private readonly logger = new Logger('OpsAlertEvaluator');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SystemHealthService) private readonly health: SystemHealthService,
    @Inject(OpsAlertDeliveryWorker) private readonly delivery: OpsAlertDeliveryWorker,
  ) {}

  @Cron(readOpsAlertCron(), { name: 'ops-alert-evaluation' })
  async tick() {
    await this.evaluate();
  }

  /** One evaluation and one delivery pass. Never throws. */
  async evaluate(now: Date = new Date()): Promise<EvaluationOutcome> {
    const outcome = await this.evaluateOnly(now);
    if (outcome !== 'BUSY') {
      try {
        await this.delivery.deliverDue();
      } catch (error) {
        this.logger.error(`ops alert delivery pass failed (${errorType(error)})`);
      }
    }
    return outcome;
  }

  async evaluateOnly(now: Date = new Date()): Promise<EvaluationOutcome> {
    try {
      await this.prisma.opsAlertEngineState.upsert({
        where: { id: OPS_ALERT_ENGINE_STATE_ID },
        create: { id: OPS_ALERT_ENGINE_STATE_ID, lastStartedAt: now },
        update: { lastStartedAt: now },
      });
      const { jobs } = await this.health.readSchedulerFacts(now);
      const config = readOpsAlertConfigSafely();

      return await this.prisma.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${OPS_ALERT_ADVISORY_LOCK_KEY}::bigint) AS "locked"`;
          if (!lock?.locked) return 'BUSY' as const;

          const state = await tx.opsAlertEngineState.findUnique({
            where: { id: OPS_ALERT_ENGINE_STATE_ID },
            select: { emailCursor: true },
          });
          const open = new Map(
            (await tx.opsAlert.findMany({ where: { state: OpsAlertState.OPEN }, select: openAlertSelect })).map(
              (alert) => [alert.fingerprint, alert as OpenAlert],
            ),
          );

          await this.applySchedulers(tx, jobs, open, config, now);
          const emailCursor = await this.applyEmail(tx, state?.emailCursor ?? null, open, config, now);

          await tx.opsAlertEngineState.update({
            where: { id: OPS_ALERT_ENGINE_STATE_ID },
            data: { lastSucceededAt: now, emailCursor },
          });
          return 'EVALUATED' as const;
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
    } catch (error) {
      const type = errorType(error);
      this.logger.error(`ops alert evaluation failed (${type})`);
      try {
        await this.prisma.opsAlertEngineState.upsert({
          where: { id: OPS_ALERT_ENGINE_STATE_ID },
          create: { id: OPS_ALERT_ENGINE_STATE_ID, lastFailedAt: now, lastErrorType: type },
          update: { lastFailedAt: now, lastErrorType: type },
        });
      } catch {
        // The database is the likely cause; the log line above is the record.
      }
      return 'FAILED';
    }
  }

  // ---------------------------------------------------------------------------
  // Schedulers
  // ---------------------------------------------------------------------------

  private async applySchedulers(
    tx: Tx,
    jobs: Awaited<ReturnType<SystemHealthService['readSchedulerFacts']>>['jobs'],
    open: Map<string, OpenAlert>,
    config: OpsAlertConfig,
    now: Date,
  ) {
    for (const job of jobs) {
      const decision = schedulerDecision(job, now);
      const jobAlerts = [...open.values()].filter(
        (alert) => alert.source === OpsAlertSource.SCHEDULER && alert.subjectKey === job.key,
      );

      if (decision.kind === 'NEUTRAL') {
        if (decision.resolveOverdue) {
          for (const alert of jobAlerts.filter((candidate) => candidate.condition === 'OVERDUE')) {
            await this.resolve(tx, alert, 'RECOVERED', open, config, now);
          }
        }
        continue;
      }
      if (decision.kind === 'RESOLVE') {
        for (const alert of jobAlerts) await this.resolve(tx, alert, decision.resolution, open, config, now);
        continue;
      }

      // A different problem on the same job replaces the old one: the new
      // alert's OPENED says what is wrong now, and the old one closes quietly.
      for (const alert of jobAlerts.filter((candidate) => candidate.condition !== decision.condition)) {
        await this.resolve(tx, alert, 'SUPERSEDED', open, config, now);
      }
      await this.observe(
        tx,
        {
          source: OpsAlertSource.SCHEDULER,
          subjectKey: job.key,
          condition: decision.condition,
          severity: () => decision.severity,
          firstSeenAt: decision.seenAt,
          lastSeenAt: decision.seenAt,
          occurrence:
            decision.condition === 'OVERDUE'
              ? { atLeast: Math.max(1, decision.detail.missedTicks ?? 1) }
              : { key: decision.occurrenceKey },
          detail: { ...decision.detail, occurrenceKey: decision.occurrenceKey },
        },
        open,
        config,
        now,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // E-mail
  // ---------------------------------------------------------------------------

  /**
   * Reads e-mails that FAILED after the cursor (and up to a few seconds ago),
   * grouped by error class and template, then judges recovery for every open
   * e-mail alert. Returns the new cursor.
   */
  private async applyEmail(
    tx: Tx,
    cursor: Date | null,
    open: Map<string, OpenAlert>,
    config: OpsAlertConfig,
    now: Date,
  ): Promise<Date> {
    const since = cursor ?? new Date(now.getTime() - EMAIL_INITIAL_LOOKBACK_MS);
    const until = new Date(now.getTime() - EMAIL_CURSOR_SETTLE_MS);
    let nextCursor = since;

    if (until > since) {
      const rows = await tx.notificationLog.groupBy({
        by: ['errorCode', 'template'],
        where: {
          channel: NotificationChannel.EMAIL,
          status: NotificationStatus.FAILED,
          createdAt: { gte: new Date(now.getTime() - EMAIL_FAILURE_LOOKBACK_MS) },
          failedAt: { gt: since, lte: until },
        },
        _count: { _all: true },
        _min: { failedAt: true },
        _max: { failedAt: true },
      });

      const byCode = new Map<NotificationErrorCode, { count: number; first: Date; last: Date; templates: Set<string> }>();
      for (const row of rows) {
        const code = normalizeStoredErrorCode(row.errorCode) ?? 'UNKNOWN';
        if (!isAlertableEmailCode(code)) continue;
        const first = row._min.failedAt ?? until;
        const last = row._max.failedAt ?? until;
        const entry = byCode.get(code) ?? { count: 0, first, last, templates: new Set<string>() };
        entry.count += row._count._all;
        if (first < entry.first) entry.first = first;
        if (last > entry.last) entry.last = last;
        entry.templates.add(row.template);
        byCode.set(code, entry);
      }

      for (const [code, entry] of byCode) {
        await this.observe(
          tx,
          {
            source: OpsAlertSource.EMAIL,
            subjectKey: code,
            condition: 'SEND_FAILURES',
            severity: (occurrences) => emailSeverity(code, occurrences),
            firstSeenAt: entry.first,
            lastSeenAt: entry.last,
            occurrence: { add: entry.count },
            detail: { templates: [...entry.templates] },
          },
          open,
          config,
          now,
        );
      }
      nextCursor = until;
    }

    for (const alert of [...open.values()].filter((candidate) => candidate.source === OpsAlertSource.EMAIL)) {
      if (now.getTime() - alert.lastSeenAt.getTime() < EMAIL_RECOVERY_QUIET_MS) continue;
      // The evidence: a message that really left after the last failure.
      const sent = await tx.notificationLog.findFirst({
        where: {
          channel: NotificationChannel.EMAIL,
          status: NotificationStatus.SENT,
          createdAt: { gte: new Date(alert.lastSeenAt.getTime() - EMAIL_FAILURE_LOOKBACK_MS) },
          sentAt: { gt: alert.lastSeenAt },
        },
        select: { id: true },
      });
      if (emailRecovered(alert.lastSeenAt, now, sent !== null)) {
        await this.resolve(tx, alert, 'RECOVERED', open, config, now);
      }
    }
    return nextCursor;
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  /** Opens the alert for an observation, or carries it forward. */
  private async observe(tx: Tx, seen: Observation, open: Map<string, OpenAlert>, config: OpsAlertConfig, now: Date) {
    const fingerprint = alertFingerprint(seen.source, seen.subjectKey, seen.condition);
    const existing = open.get(fingerprint);

    if (!existing) {
      const occurrenceCount =
        'add' in seen.occurrence ? Math.max(1, seen.occurrence.add) : 'atLeast' in seen.occurrence ? seen.occurrence.atLeast : 1;
      const severity = seen.severity(occurrenceCount);
      const firstSeenAt = seen.firstSeenAt;
      const lastSeenAt = seen.lastSeenAt < firstSeenAt ? firstSeenAt : seen.lastSeenAt;
      const created = await tx.opsAlert.create({
        data: {
          ref: newAlertRef(),
          fingerprint,
          source: seen.source,
          subjectKey: seen.subjectKey,
          condition: seen.condition,
          severity,
          firstSeenAt,
          lastSeenAt,
          occurrenceCount,
          lastNotifiedAt: now,
          detail: safeDetail(seen.detail, null) as Prisma.InputJsonValue,
        },
        select: openAlertSelect,
      });
      open.set(fingerprint, created as OpenAlert);
      await this.queue(tx, created.id, OpsAlertNoticeKind.OPENED, 0, noticeChannels(OpsAlertNoticeKind.OPENED, severity, config, new Set()), now);
      return;
    }

    const previousDetail = (existing.detail ?? {}) as Record<string, unknown>;
    let occurrenceCount = existing.occurrenceCount;
    let lastSeenAt = existing.lastSeenAt;
    if ('key' in seen.occurrence) {
      if (previousDetail.occurrenceKey !== seen.occurrence.key) {
        occurrenceCount += 1;
        if (seen.lastSeenAt > lastSeenAt) lastSeenAt = seen.lastSeenAt;
      }
    } else if ('add' in seen.occurrence) {
      occurrenceCount += seen.occurrence.add;
      if (seen.lastSeenAt > lastSeenAt) lastSeenAt = seen.lastSeenAt;
    } else {
      occurrenceCount = Math.max(occurrenceCount, seen.occurrence.atLeast);
      if (seen.lastSeenAt > lastSeenAt) lastSeenAt = seen.lastSeenAt;
    }

    // Severity only rises while an alert is open; a rise is news right away.
    const proposed = seen.severity(occurrenceCount);
    const severity =
      existing.severity === OpsAlertSeverity.CRITICAL || proposed === OpsAlertSeverity.CRITICAL
        ? OpsAlertSeverity.CRITICAL
        : OpsAlertSeverity.WARNING;
    const escalated = existing.severity === OpsAlertSeverity.WARNING && severity === OpsAlertSeverity.CRITICAL;
    const remind = escalated || reminderDue({ lastSeenAt, lastNotifiedAt: existing.lastNotifiedAt }, now);
    const reminderCount = remind ? existing.reminderCount + 1 : existing.reminderCount;
    const lastNotifiedAt = remind ? now : existing.lastNotifiedAt;

    const updated = await tx.opsAlert.update({
      where: { id: existing.id },
      data: {
        severity,
        lastSeenAt,
        occurrenceCount,
        reminderCount,
        lastNotifiedAt,
        detail: safeDetail(seen.detail, previousDetail) as Prisma.InputJsonValue,
      },
      select: openAlertSelect,
    });
    open.set(fingerprint, updated as OpenAlert);

    if (remind) {
      await this.queue(
        tx,
        existing.id,
        OpsAlertNoticeKind.REMINDER,
        reminderCount,
        noticeChannels(OpsAlertNoticeKind.REMINDER, severity, config, new Set()),
        now,
      );
    }
  }

  /**
   * Closes an alert once. Notices that never went out are cancelled — a late
   * "new problem" about something already fixed is noise — and the RESOLVED
   * notice goes only to channels that were told (or are being told) about it.
   * A SUPERSEDED alert sends nothing: its successor's OPENED is the news.
   */
  private async resolve(
    tx: Tx,
    alert: OpenAlert,
    resolution: OpsAlertResolution,
    open: Map<string, OpenAlert>,
    config: OpsAlertConfig,
    now: Date,
  ) {
    const closed = await tx.opsAlert.updateMany({
      where: { id: alert.id, state: OpsAlertState.OPEN },
      data: { state: OpsAlertState.RESOLVED, resolvedAt: now, resolution },
    });
    open.delete(alert.fingerprint);
    if (closed.count === 0) return;

    await tx.opsAlertDelivery.updateMany({
      where: {
        alertId: alert.id,
        status: { in: [OpsAlertDeliveryStatus.PENDING, OpsAlertDeliveryStatus.FAILED] },
      },
      data: { status: OpsAlertDeliveryStatus.CANCELLED, errorCode: 'ALERT_CLOSED' },
    });
    if (resolution === 'SUPERSEDED') return;

    const told = await tx.opsAlertDelivery.findMany({
      where: {
        alertId: alert.id,
        status: { in: [OpsAlertDeliveryStatus.SENT, OpsAlertDeliveryStatus.SENDING] },
      },
      select: { channel: true },
      distinct: ['channel'],
    });
    const channels = noticeChannels(
      OpsAlertNoticeKind.RESOLVED,
      alert.severity,
      config,
      new Set<OpsAlertChannel>(told.map((row) => row.channel)),
    );
    await this.queue(tx, alert.id, OpsAlertNoticeKind.RESOLVED, 0, channels, now);
  }

  /** One row per channel; the unique key makes a repeat a no-op. */
  private async queue(
    tx: Tx,
    alertId: string,
    kind: OpsAlertNoticeKind,
    sequence: number,
    channels: OpsAlertChannel[],
    now: Date,
  ) {
    if (channels.length === 0) return;
    await tx.opsAlertDelivery.createMany({
      data: channels.map((channel) => ({ alertId, kind, sequence, channel, nextAttemptAt: now })),
      skipDuplicates: true,
    });
  }
}

/**
 * The allow-listed facts an alert keeps. Anything else an observation carries
 * is dropped here, so a future caller cannot widen what the table holds by
 * accident.
 */
function safeDetail(next: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  if (typeof next.reason === 'string') detail.reason = next.reason;
  if (typeof next.missedTicks === 'number') detail.missedTicks = next.missedTicks;
  if (typeof next.occurrenceKey === 'string') detail.occurrenceKey = next.occurrenceKey.slice(0, 80);
  if (Array.isArray(next.templates)) {
    detail.templates = mergeTemplates(previous?.templates, next.templates.filter((value): value is string => typeof value === 'string'));
  }
  return detail;
}

function errorType(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  return (name.startsWith('PrismaClient') ? 'DATABASE_ERROR' : 'APPLICATION_ERROR');
}

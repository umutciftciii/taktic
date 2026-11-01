import { randomBytes } from 'node:crypto';
import { OpsAlertChannel, OpsAlertEmailRouting, OpsAlertNoticeKind, OpsAlertSeverity, OpsAlertSource } from '@prisma/client';
import { formatDateTime } from '../notifications/templates/format';
import {
  NOTIFICATION_ERROR_CODES,
  NotificationErrorCode,
  notificationErrorLabel,
} from '../notifications/notification-errors';
import { RecordedJobKey, SCHEDULER_JOB_MOVES_MONEY, isSchedulerJobKey } from '../operations-settings/scheduler-jobs';
import { HealthStatus, SchedulerReason, countMissedTicks, SCHEDULER_MISSED_TICKS_DOWN } from '../system-health/system-health.rules';
import type { SchedulerErrorType } from '../system-health/system-health.service';
import type { OpsAlertConfig } from './ops-alert.config';

/**
 * OBS-ALERT-001 — the rules of the operations alert engine.
 *
 * Pure functions, apart from the evaluator that gathers the facts and the
 * worker that sends, so every threshold here is pinned by a unit test.
 *
 * The life of one alert:
 *
 *   problem seen, no OPEN alert carries its fingerprint   → OPENED
 *   still there, seen again since the last notice, and
 *   REMINDER_INTERVAL_MS since that notice                → REMINDER
 *   severity rose (WARNING → CRITICAL)                    → REMINDER now
 *   the condition cleared (rules per source below)        → RESOLVED, once
 *   the job was switched off                              → RESOLVED (DISABLED)
 *   the same job now has a different problem              → closed SUPERSEDED,
 *                                                           and the new one OPENED
 *
 * Each notice becomes one delivery per channel it is routed to, and each
 * delivery retries on its own; a channel that is down never holds the other.
 * With managed recipients (OBS-ALERT-002, routing MANAGED) e-mail is one
 * delivery per recipient, bound to it for good ({@link noticeTargets}).
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** A problem that is still there is mentioned again at most this often. */
export const REMINDER_INTERVAL_MS = 6 * 60 * 60_000;
/**
 * E-mail is recovered only after this long without a new failure, and only
 * with a SENT message after the last failure as evidence ({@link emailRecovered}).
 */
export const EMAIL_RECOVERY_QUIET_MS = 30 * 60_000;
/** How far back failed e-mails are read; the cursor narrows it further. */
export const EMAIL_FAILURE_LOOKBACK_MS = 24 * 60 * 60_000;
/** The first evaluation ever looks back only this far: history is not news. */
export const EMAIL_INITIAL_LOOKBACK_MS = 30 * 60_000;
/**
 * The cursor stops this far behind now, so a failure whose transaction has
 * not committed yet when a tick reads is still read by the next one.
 */
export const EMAIL_CURSOR_SETTLE_MS = 10_000;

/** A delivery claim is honoured this long; past it, another worker may take it. */
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** Attempts per delivery, the first included. */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** The wait before attempt n+1, by attempts made so far (1-based). */
const DELIVERY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** Due deliveries one pass claims. */
export const DELIVERY_BATCH = 20;

export function deliveryBackoffMs(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1), DELIVERY_BACKOFF_MS.length) - 1;
  return DELIVERY_BACKOFF_MS[index] ?? DELIVERY_BACKOFF_MS[DELIVERY_BACKOFF_MS.length - 1]!;
}

export const OPS_ALERT_ENGINE_STATE_ID = 'ops-alert-engine';
/** pg_try_advisory_xact_lock key: one evaluator at a time, across instances. */
export const OPS_ALERT_ADVISORY_LOCK_KEY = 0x0b5a1e01;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A scheduler alert's condition: the run's error type, or late. */
export type SchedulerAlertCondition = SchedulerErrorType | 'OVERDUE';
/** An e-mail alert's condition. Its subject is the error class. */
export type EmailAlertCondition = 'SEND_FAILURES';
export type OpsAlertCondition = SchedulerAlertCondition | EmailAlertCondition;

export type OpsAlertResolution = 'RECOVERED' | 'DISABLED' | 'SUPERSEDED';

export function alertFingerprint(source: OpsAlertSource, subjectKey: string, condition: OpsAlertCondition): string {
  return `${source}:${subjectKey}:${condition}`;
}

/** "OPS-" and ten base32 characters: fixed for the alert's life, and meaningless. */
export function newAlertRef(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(10);
  let ref = 'OPS-';
  for (const byte of bytes) ref += alphabet[byte % alphabet.length];
  return ref;
}

/** The operations screen's own names for the jobs (admin lib/api.ts SCHEDULER_JOB_COPY). */
const JOB_LABELS: Record<RecordedJobKey, string> = {
  'entitlement-renewal': 'Paket yenileme',
  'unviewed-offer-refund': 'Görüntülenmeyen teklif iadesi',
  'request-expiry': 'Talep süresi dolumu',
  'request-reminder': 'Talep hatırlatması',
  'showcase-lead-sla': 'Vitrin talebi yanıt süresi',
  'showcase-placement-expiry': 'Vitrin yerleşimi süre dolumu',
  'seo-not-found-retention': '404 önerisi temizliği (SEO)',
};

const CONDITION_LABELS: Record<OpsAlertCondition, string> = {
  PROCESS_INTERRUPTED: 'Çalışma yarıda kaldı',
  DATABASE_ERROR: 'Veritabanı hatası',
  APPLICATION_ERROR: 'Uygulama hatası',
  OVERDUE: 'Zamanında çalışmadı',
  SEND_FAILURES: 'E-posta gönderilemiyor',
};

export const SEVERITY_LABELS: Record<OpsAlertSeverity, string> = { WARNING: 'Uyarı', CRITICAL: 'Kritik' };
const SOURCE_LABELS: Record<OpsAlertSource, string> = { SCHEDULER: 'Zamanlanmış iş', EMAIL: 'E-posta' };

export function subjectLabel(source: OpsAlertSource, subjectKey: string): string {
  if (source === OpsAlertSource.SCHEDULER) return JOB_LABELS[subjectKey as RecordedJobKey] ?? subjectKey;
  return isNotificationErrorCode(subjectKey) ? notificationErrorLabel(subjectKey) : subjectKey;
}

export function conditionLabel(condition: string): string {
  return CONDITION_LABELS[condition as OpsAlertCondition] ?? condition;
}

function isNotificationErrorCode(value: string): value is NotificationErrorCode {
  return (NOTIFICATION_ERROR_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Schedulers
// ---------------------------------------------------------------------------

/** The part of the health screen's job row the decision reads. */
export type SchedulerJobObservation = {
  key: RecordedJobKey;
  enabled: boolean;
  status: HealthStatus;
  reason: SchedulerReason;
  missedTicks: number;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; errorType: SchedulerErrorType | null } | null;
};

export type SchedulerDecision =
  /** Nothing to judge: never ran and not yet due, or a run is open. */
  | { kind: 'NEUTRAL'; resolveOverdue: boolean }
  | { kind: 'RESOLVE'; resolution: 'RECOVERED' | 'DISABLED' }
  | {
      kind: 'PROBLEM';
      condition: SchedulerAlertCondition;
      severity: OpsAlertSeverity;
      /** When this problem was last true. */
      seenAt: Date;
      /** What makes one occurrence differ from the next (the failed run). */
      occurrenceKey: string;
      detail: { missedTicks?: number; reason: SchedulerReason };
    };

/**
 * One job's alert decision, from the same evaluation the health screen shows
 * (evaluateSchedulerJob) — so the alert and the screen never disagree.
 *
 *   switched off                          resolve as DISABLED; never alert
 *   never ran, first tick not yet due     neutral (NO_RECORDED_RUN)
 *   a run is open                         neutral; a late alert is over
 *   overdue (the screen's rule)           OVERDUE; CRITICAL at 3 missed ticks
 *   last run failed / interrupted         its error type; CRITICAL when the
 *                                         screen says DOWN (3 in a row) or the
 *                                         job moves money
 *   last run succeeded, on time           resolve as RECOVERED
 */
export function schedulerDecision(job: SchedulerJobObservation, now: Date): SchedulerDecision {
  if (!job.enabled) return { kind: 'RESOLVE', resolution: 'DISABLED' };
  switch (job.reason) {
    case 'DISABLED':
      return { kind: 'RESOLVE', resolution: 'DISABLED' };
    case 'NO_RECORDED_RUN':
      return { kind: 'NEUTRAL', resolveOverdue: false };
    case 'RUNNING':
      return { kind: 'NEUTRAL', resolveOverdue: true };
    case 'LAST_RUN_SUCCEEDED':
      return { kind: 'RESOLVE', resolution: 'RECOVERED' };
    case 'OVERDUE':
      return {
        kind: 'PROBLEM',
        condition: 'OVERDUE',
        severity: job.missedTicks >= SCHEDULER_MISSED_TICKS_DOWN ? OpsAlertSeverity.CRITICAL : OpsAlertSeverity.WARNING,
        seenAt: now,
        occurrenceKey: `missed:${job.missedTicks}`,
        detail: { missedTicks: job.missedTicks, reason: job.reason },
      };
    case 'LAST_RUN_FAILED':
    case 'LAST_RUN_INTERRUPTED':
    case 'REPEATED_FAILURES': {
      const run = job.lastRun;
      if (!run) return { kind: 'NEUTRAL', resolveOverdue: false };
      const movesMoney = isSchedulerJobKey(job.key) && SCHEDULER_JOB_MOVES_MONEY[job.key];
      return {
        kind: 'PROBLEM',
        condition: run.errorType ?? 'APPLICATION_ERROR',
        severity: job.status === 'DOWN' || movesMoney ? OpsAlertSeverity.CRITICAL : OpsAlertSeverity.WARNING,
        seenAt: new Date(run.finishedAt ?? run.startedAt),
        occurrenceKey: `run:${run.startedAt}`,
        detail: { reason: job.reason },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/**
 * Failures about one recipient — an address that bounced, an account whose
 * address was released — are that recipient's, not an operations problem;
 * the notification screen lists them. Everything else (transport, timeouts,
 * configuration, unknown) is alerted.
 */
const RECIPIENT_LEVEL_CODES: ReadonlySet<NotificationErrorCode> = new Set(['INVALID_RECIPIENT', 'RECIPIENT_RELEASED']);
/** Codes that mean no mail is leaving at all: CRITICAL from the first one. */
const SYSTEMIC_CODES: ReadonlySet<NotificationErrorCode> = new Set([
  'TRANSPORT_UNAVAILABLE',
  'EMAIL_BRANDING_INCOMPLETE',
  'EMAIL_PUBLIC_URL_INVALID',
]);
/** Failures of one class in one incident at which it is CRITICAL. */
export const EMAIL_CRITICAL_OCCURRENCES = 3;

export function isAlertableEmailCode(code: NotificationErrorCode): boolean {
  return !RECIPIENT_LEVEL_CODES.has(code);
}

export function emailSeverity(code: NotificationErrorCode, occurrences: number): OpsAlertSeverity {
  return SYSTEMIC_CODES.has(code) || occurrences >= EMAIL_CRITICAL_OCCURRENCES
    ? OpsAlertSeverity.CRITICAL
    : OpsAlertSeverity.WARNING;
}

/**
 * E-mail recovered: no failure of this class for the quiet period, and a
 * message really left after the last one. Silence alone is not recovery — a
 * quiet hour on a broken transport looks exactly like that.
 */
export function emailRecovered(lastSeenAt: Date, now: Date, sentSinceLastFailure: boolean): boolean {
  return now.getTime() - lastSeenAt.getTime() >= EMAIL_RECOVERY_QUIET_MS && sentSinceLastFailure;
}

/** The safe facts an e-mail alert keeps: template names (an enum), capped. */
export const EMAIL_DETAIL_TEMPLATES_MAX = 10;

export function mergeTemplates(previous: unknown, next: readonly string[]): string[] {
  const known = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === 'string') : [];
  return [...new Set([...known, ...next])].sort().slice(0, EMAIL_DETAIL_TEMPLATES_MAX);
}

// ---------------------------------------------------------------------------
// Notices and channels
// ---------------------------------------------------------------------------

/**
 * A reminder is due when the problem was seen again after the last notice
 * and the interval has passed — a problem that only lingers in the past is
 * not mentioned again.
 */
export function reminderDue(alert: { lastSeenAt: Date; lastNotifiedAt: Date }, now: Date): boolean {
  return alert.lastSeenAt > alert.lastNotifiedAt && now.getTime() - alert.lastNotifiedAt.getTime() >= REMINDER_INTERVAL_MS;
}

/**
 * Which channels a notice goes to.
 *
 *   e-mail      every notice, when OPS_ALERT_EMAIL is set
 *   Telegram    OPENED and REMINDER of a CRITICAL alert; RESOLVED only to
 *               a chat that was told about the alert in the first place
 *
 * A RESOLVED notice goes only where an earlier notice went (or is going):
 * nobody is told "it is fixed" about something they never heard of.
 */
export function noticeChannels(
  kind: OpsAlertNoticeKind,
  severity: OpsAlertSeverity,
  config: Pick<OpsAlertConfig, 'email' | 'telegram'>,
  toldChannels: ReadonlySet<OpsAlertChannel>,
): OpsAlertChannel[] {
  const channels: OpsAlertChannel[] = [];
  if (kind === OpsAlertNoticeKind.RESOLVED) {
    if (config.telegram && toldChannels.has(OpsAlertChannel.TELEGRAM)) channels.push(OpsAlertChannel.TELEGRAM);
    if (config.email && toldChannels.has(OpsAlertChannel.EMAIL)) channels.push(OpsAlertChannel.EMAIL);
    return channels;
  }
  if (config.telegram && severity === OpsAlertSeverity.CRITICAL) channels.push(OpsAlertChannel.TELEGRAM);
  if (config.email) channels.push(OpsAlertChannel.EMAIL);
  return channels;
}

/**
 * OBS-ALERT-002 — one delivery row a notice becomes. An e-mail target names
 * the managed recipient it is bound to for good, or `null` for the
 * OPS_ALERT_EMAIL address (ENV_LEGACY).
 */
export type NoticeTarget = { channel: 'TELEGRAM' } | { channel: 'EMAIL'; recipientId: string | null };

/** A managed recipient as routing reads it: who, and what they asked for. */
export type NoticeRecipient = { id: string; notifyWarning: boolean; notifyCritical: boolean; notifyRecovery: boolean };

/**
 * Whether a recipient's preferences take a notice of this kind and severity:
 * OPENED/REMINDER by the severity, RESOLVED by recovery. Whether the recipient
 * was told about the alert at all is a separate question ({@link noticeTargets}).
 */
export function recipientWants(
  kind: OpsAlertNoticeKind,
  severity: OpsAlertSeverity,
  recipient: Omit<NoticeRecipient, 'id'>,
): boolean {
  if (kind === OpsAlertNoticeKind.RESOLVED) return recipient.notifyRecovery;
  return severity === OpsAlertSeverity.CRITICAL ? recipient.notifyCritical : recipient.notifyWarning;
}

/**
 * Where a notice goes, by the e-mail routing mode.
 *
 *   ENV_LEGACY   exactly {@link noticeChannels} — the OBS-ALERT-001 rule has
 *                one home, and managed recipients are not consulted at all
 *   MANAGED      Telegram as in OBS-ALERT-001; e-mail one row per ACTIVE
 *                recipient (the caller passes only those) whose preference
 *                takes the severity — and for RESOLVED, only a recipient that
 *                was told about the alert and still wants recovery notices.
 *                The env address is never a target in this mode.
 *
 * `told` is what the alert's SENT/SENDING rows say: Telegram, the legacy
 * address, and the managed recipients by id.
 */
export function noticeTargets(
  kind: OpsAlertNoticeKind,
  severity: OpsAlertSeverity,
  ctx: {
    routing: OpsAlertEmailRouting;
    config: Pick<OpsAlertConfig, 'email' | 'telegram'>;
    recipients: ReadonlyArray<NoticeRecipient>;
    told: { telegram: boolean; legacyEmail: boolean; recipientIds: ReadonlySet<string> };
  },
): NoticeTarget[] {
  if (ctx.routing !== OpsAlertEmailRouting.MANAGED) {
    const toldChannels = new Set<OpsAlertChannel>();
    if (ctx.told.telegram) toldChannels.add(OpsAlertChannel.TELEGRAM);
    if (ctx.told.legacyEmail) toldChannels.add(OpsAlertChannel.EMAIL);
    return noticeChannels(kind, severity, ctx.config, toldChannels).map((channel) =>
      channel === OpsAlertChannel.TELEGRAM ? { channel: 'TELEGRAM' as const } : { channel: 'EMAIL' as const, recipientId: null },
    );
  }

  const targets: NoticeTarget[] = [];
  // Telegram is not managed: its rule is noticeChannels' with no e-mail.
  const telegramOnly = { email: null, telegram: ctx.config.telegram };
  const toldTelegram = new Set<OpsAlertChannel>(ctx.told.telegram ? [OpsAlertChannel.TELEGRAM] : []);
  if (noticeChannels(kind, severity, telegramOnly, toldTelegram).includes(OpsAlertChannel.TELEGRAM)) {
    targets.push({ channel: 'TELEGRAM' });
  }
  for (const recipient of ctx.recipients) {
    if (kind === OpsAlertNoticeKind.RESOLVED && !ctx.told.recipientIds.has(recipient.id)) continue;
    if (!recipientWants(kind, severity, recipient)) continue;
    targets.push({ channel: 'EMAIL', recipientId: recipient.id });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** The alert as a notice is composed from it — no field beyond these. */
export type NoticeAlert = {
  ref: string;
  source: OpsAlertSource;
  subjectKey: string;
  condition: string;
  severity: OpsAlertSeverity;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  resolvedAt: Date | null;
  resolution: string | null;
  detail: unknown;
};

export type ComposedNotice = {
  /** The template data for `ops-alert`. Labels, counts, times, the ref, one link. */
  emailData: Record<string, string>;
  telegramText: string;
};

const NOTICE_HEADLINES: Record<OpsAlertNoticeKind, string> = {
  OPENED: 'Yeni sorun',
  REMINDER: 'Sorun sürüyor',
  RESOLVED: 'Düzeldi',
};

function detailTemplates(detail: unknown): string[] {
  const templates = (detail as { templates?: unknown } | null)?.templates;
  return mergeTemplates(templates, []);
}

function summaryOf(kind: OpsAlertNoticeKind, alert: NoticeAlert): string {
  const subject = subjectLabel(alert.source, alert.subjectKey);
  if (kind === OpsAlertNoticeKind.RESOLVED) {
    if (alert.resolution === 'DISABLED') return `${subject} işi operasyon ayarlarından kapatıldı; alarm kapandı.`;
    return alert.source === OpsAlertSource.EMAIL
      ? `E-posta gönderimi yeniden başarılı (${subject}); 30 dakikadır yeni hata yok.`
      : `${subject} işi yeniden başarıyla çalıştı.`;
  }
  if (alert.source === OpsAlertSource.EMAIL) return `E-postalar gönderilemiyor: ${subject}.`;
  if (alert.condition === 'OVERDUE') return `${subject} işi zamanında çalışmadı.`;
  return `${subject} işi başarısız oldu: ${conditionLabel(alert.condition)}.`;
}

/**
 * The one link every notice carries: the system health screen, no
 * parameter, on the configured panel origin — or no link at all when that
 * origin is not a plain http(s) address.
 */
export function systemHealthUrl(adminBaseUrl: string): string | null {
  try {
    const url = new URL('/system-health', adminBaseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Builds both channels' text from the alert's own safe fields. Nothing here
 * reads a NotificationLog row, a recipient, a run summary or an error message;
 * the inputs are keys, closed codes, counts and times.
 */
export function composeNotice(kind: OpsAlertNoticeKind, alert: NoticeAlert, adminUrl: string | null): ComposedNotice {
  const subject = subjectLabel(alert.source, alert.subjectKey);
  const condition = conditionLabel(alert.condition);
  const summary = summaryOf(kind, alert);
  const templates = alert.source === OpsAlertSource.EMAIL ? detailTemplates(alert.detail).join(', ') : '';
  const firstSeen = formatDateTime(alert.firstSeenAt) ?? '';
  const lastSeen = formatDateTime(alert.lastSeenAt) ?? '';
  const resolvedAt = alert.resolvedAt ? (formatDateTime(alert.resolvedAt) ?? '') : '';

  const emailData: Record<string, string> = {
    fullName: 'Operasyon Ekibi',
    noticeKind: kind,
    severity: alert.severity,
    severityLabel: SEVERITY_LABELS[alert.severity],
    alertRef: alert.ref,
    sourceLabel: SOURCE_LABELS[alert.source],
    subjectLabel: subject,
    conditionLabel: condition,
    summary,
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    occurrenceCount: String(alert.occurrenceCount),
    templates,
    resolvedAt,
    adminUrl: adminUrl ?? '',
  };

  const level = kind === OpsAlertNoticeKind.RESOLVED ? '✅' : alert.severity === OpsAlertSeverity.CRITICAL ? '🔴 KRİTİK' : '🟠 UYARI';
  const lines = [
    `${level} · TakTick operasyon · ${NOTICE_HEADLINES[kind]}`,
    summary,
    '',
    `Olay: ${alert.ref}`,
    `Kaynak: ${SOURCE_LABELS[alert.source]} — ${subject}`,
    `Hata türü: ${condition}`,
    `İlk görülme: ${firstSeen}`,
    `Son görülme: ${lastSeen}`,
    `Tekrar: ${alert.occurrenceCount}`,
    ...(templates ? [`Şablonlar: ${templates}`] : []),
    ...(resolvedAt ? [`Kapanış: ${resolvedAt}`] : []),
    ...(adminUrl ? ['', adminUrl] : []),
  ];
  return { emailData, telegramText: lines.join('\n') };
}

/** The headline of a test notice (OBS-ALERT-002). */
export const TEST_NOTICE_HEADLINE = 'Test bildirimi';

/**
 * OBS-ALERT-002 — the synthetic notice an operator sends to one recipient to
 * prove the mailbox receives alert e-mail. Same `ops-alert` template, fixed
 * text: no alert, no reference, no OPS id, the one system health link.
 */
export function composeTestNotice(adminUrl: string | null): ComposedNotice {
  const summary = 'Bu bir test bildirimidir: operasyon alarmı e-postaları bu adrese ulaşıyor. Herhangi bir işlem gerekmiyor.';
  const emailData: Record<string, string> = {
    fullName: 'Operasyon Ekibi',
    noticeKind: 'TEST',
    severity: OpsAlertSeverity.WARNING,
    severityLabel: 'Bilgi',
    alertRef: '',
    sourceLabel: 'Bildirim ayarları',
    subjectLabel: TEST_NOTICE_HEADLINE,
    conditionLabel: '',
    summary,
    firstSeenAt: '',
    lastSeenAt: '',
    occurrenceCount: '',
    templates: '',
    resolvedAt: '',
    adminUrl: adminUrl ?? '',
  };
  const lines = [`TakTick operasyon · ${TEST_NOTICE_HEADLINE}`, summary, ...(adminUrl ? ['', adminUrl] : [])];
  return { emailData, telegramText: lines.join('\n') };
}

/**
 * OBS-ALERT-002 — what a delivery row carries from the moment it is queued.
 * Content is fixed here so a retry under the same idempotency key can never
 * carry different content (the provider would answer 409).
 */
export type NoticeSnapshot = {
  v: 1;
  /** The alert's severity when the row was queued; preference checks read this. */
  severity: OpsAlertSeverity;
  emailData: Record<string, string>;
  telegramText: string;
};

export function snapshotNotice(kind: OpsAlertNoticeKind, alert: NoticeAlert, adminUrl: string | null): NoticeSnapshot {
  const { emailData, telegramText } = composeNotice(kind, alert, adminUrl);
  return { v: 1, severity: alert.severity, emailData, telegramText };
}

/** Strict reader: anything that is not exactly a v1 snapshot is null (compose live). */
export function readNoticeSnapshot(value: unknown): NoticeSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) return null;
  if (candidate.severity !== OpsAlertSeverity.WARNING && candidate.severity !== OpsAlertSeverity.CRITICAL) return null;
  if (typeof candidate.telegramText !== 'string') return null;
  const data = candidate.emailData;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const emailData: Record<string, string> = {};
  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry !== 'string') return null;
    emailData[key] = entry;
  }
  return { v: 1, severity: candidate.severity, emailData, telegramText: candidate.telegramText };
}

// ---------------------------------------------------------------------------
// The engine itself
// ---------------------------------------------------------------------------

export type EngineReason = 'OK' | 'NEVER_RAN' | 'OVERDUE' | 'LAST_EVALUATION_FAILED';

/**
 * Whether the alert engine is itself running, by the health screen's own
 * tick rule: missed ticks of its cron since the last successful evaluation.
 * It cannot alert about itself (that is the next phase's external watchdog);
 * the health screen is where its silence shows.
 */
export function evaluateEngine(
  state: { lastSucceededAt: Date | null; lastFailedAt: Date | null } | null,
  cron: string,
  now: Date,
  bootedAt: Date,
): { status: HealthStatus; reason: EngineReason; missedTicks: number } {
  if (!state?.lastSucceededAt) {
    // Never succeeded: late only once a tick has passed since this process
    // started, which is when it could first have run.
    const missedTicks = countMissedTicks(cron, bootedAt, now);
    if (missedTicks >= SCHEDULER_MISSED_TICKS_DOWN) return { status: 'DOWN', reason: 'OVERDUE', missedTicks };
    if (missedTicks > 0) return { status: 'DEGRADED', reason: 'OVERDUE', missedTicks };
    return { status: 'UNKNOWN', reason: 'NEVER_RAN', missedTicks: 0 };
  }
  const missedTicks = countMissedTicks(cron, state.lastSucceededAt, now);
  if (missedTicks >= SCHEDULER_MISSED_TICKS_DOWN) return { status: 'DOWN', reason: 'OVERDUE', missedTicks };
  if (missedTicks > 0) return { status: 'DEGRADED', reason: 'OVERDUE', missedTicks };
  if (state.lastFailedAt && state.lastFailedAt > state.lastSucceededAt) {
    return { status: 'DEGRADED', reason: 'LAST_EVALUATION_FAILED', missedTicks };
  }
  return { status: 'HEALTHY', reason: 'OK', missedTicks: 0 };
}

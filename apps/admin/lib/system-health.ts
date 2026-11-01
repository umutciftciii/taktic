import { SCHEDULER_JOB_COPY, type SchedulerJobKey } from './api';

/**
 * ADMIN-SYSTEM-HEALTH-001 — the "Sistem sağlığı" screen's vocabulary.
 *
 * The API decides every state (`GET /system-health`); this file only says it
 * in Turkish, and adds the one row the API cannot measure about itself: the
 * API, as this panel's server reached it.
 */

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

type Component<Reason extends string> = { status: HealthStatus; reason: Reason; checkedAt: string };

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

export type SchedulerReason =
  | 'DISABLED'
  | 'NO_RECORDED_RUN'
  | 'RUNNING'
  | 'LAST_RUN_SUCCEEDED'
  | 'LAST_RUN_FAILED'
  | 'LAST_RUN_INTERRUPTED'
  | 'REPEATED_FAILURES'
  | 'OVERDUE';

export type SchedulerErrorType = 'PROCESS_INTERRUPTED' | 'DATABASE_ERROR' | 'APPLICATION_ERROR';

export type SystemHealthJobKey = SchedulerJobKey | 'seo-not-found-retention';

export type SystemHealthJob = {
  key: SystemHealthJobKey;
  enabled: boolean;
  switchable: boolean;
  cron: string;
  status: HealthStatus;
  reason: SchedulerReason;
  missedTicks: number;
  lastRun: {
    status: 'RUNNING' | 'SUCCESS' | 'FAILED';
    startedAt: string;
    finishedAt: string | null;
    errorType: SchedulerErrorType | null;
  } | null;
  lastSuccessAt: string | null;
  last24h: { succeeded: number; failed: number };
};

export type EmailReason = 'OK' | 'NO_TRAFFIC' | 'FAILURES' | 'MOSTLY_FAILING' | 'STUCK_PENDING' | 'QUERY_FAILED';

export type AppEnvironment = 'local' | 'staging' | 'production';

export type SystemHealthReport = {
  generatedAt: string;
  /** The deployment the API says it is; null when it has not said. */
  environment: AppEnvironment | null;
  /** Core services decide DOWN; schedulers and e-mail count at most as DEGRADED. */
  overall: HealthStatus;
  database: Component<'OK' | 'SLOW' | 'TIMEOUT' | 'UNREACHABLE'> & {
    latencyMs: number;
    appliedMigrations: number | null;
  };
  web: Component<ProbeReason> & { latencyMs: number | null; httpStatus: number | null };
  admin: Component<ProbeReason> & { latencyMs: number | null; httpStatus: number | null };
  schedulers: Component<'OK' | 'QUERY_FAILED'> & {
    jobs: SystemHealthJob[];
    recentFailures: Array<{ jobKey: SystemHealthJobKey; errorType: SchedulerErrorType; at: string }>;
  };
  /** Absent without NOTIFICATION_LOGS_READ — never an empty stand-in. */
  email?: Component<EmailReason> & {
    windowHours: number;
    counts: { sent: number; failed: number; pending: number; stuckPending: number } | null;
    lastSentAt: string | null;
    recentFailures: Array<{
      id: string;
      template: string;
      errorCode: string | null;
      errorLabel: string | null;
      at: string;
    }>;
  };
  /** OBS-ALERT-001. E-mail alerts are in it only for a NOTIFICATION_LOGS_READ holder. */
  alerts?: OpsAlertsBlock;
  notMeasured: Array<'EXTERNAL_UPTIME' | 'BACKUPS' | 'HOST_RESOURCES' | 'CAMPAIGN_EVALUATION_WORKER'>;
};

// ---------------------------------------------------------------------------
// OBS-ALERT-001 — operations alerts
// ---------------------------------------------------------------------------

export type OpsAlertEngineReason = 'OK' | 'NEVER_RAN' | 'OVERDUE' | 'LAST_EVALUATION_FAILED' | 'QUERY_FAILED';
export type OpsAlertChannel = 'TELEGRAM' | 'EMAIL';
export type OpsAlertDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'ABANDONED' | 'CANCELLED';
export type OpsAlertNoticeKind = 'OPENED' | 'REMINDER' | 'RESOLVED';

export type OpsAlertView = {
  ref: string;
  source: 'SCHEDULER' | 'EMAIL';
  subjectKey: string;
  condition: string;
  severity: 'WARNING' | 'CRITICAL';
  state: 'OPEN' | 'RESOLVED';
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  resolvedAt: string | null;
  resolution: string | null;
  deliveries: Array<{
    kind: OpsAlertNoticeKind;
    sequence: number;
    channel: OpsAlertChannel;
    status: OpsAlertDeliveryStatus;
    attemptCount: number;
    sentAt: string | null;
    errorCode: string | null;
    /**
     * OBS-ALERT-002: the managed recipient an e-mail notice is bound to; null
     * for Telegram, OPS_ALERT_EMAIL rows and callers without
     * OPS_ALERT_RECIPIENTS_READ.
     */
    recipientId: string | null;
    /** That recipient's label, never its address. Null under the same rules. */
    recipientLabel: string | null;
  }>;
};

export type OpsAlertsBlock = {
  status: HealthStatus;
  reason: OpsAlertEngineReason;
  checkedAt: string;
  engine: {
    cron: string;
    missedTicks: number;
    lastStartedAt: string | null;
    lastSucceededAt: string | null;
    lastFailedAt: string | null;
    lastErrorType: string | null;
  };
  channels: { email: boolean; telegram: boolean };
  open: OpsAlertView[];
  recentlyResolved: OpsAlertView[];
};

export const OPS_ALERT_ENGINE_REASON_TEXT: Record<OpsAlertEngineReason, string> = {
  OK: 'Alarm motoru zamanında çalışıyor.',
  NEVER_RAN: 'Alarm motoru bu süreç başladığından beri henüz çalışmadı.',
  OVERDUE: 'Alarm motoru zamanında çalışmadı; yeni sorunlar bildirilmiyor olabilir.',
  LAST_EVALUATION_FAILED: 'Alarm motorunun son değerlendirmesi hata verdi.',
  QUERY_FAILED: 'Alarm kayıtları okunamadı.',
};

export const OPS_ALERT_CONDITION_TEXT: Record<string, string> = {
  PROCESS_INTERRUPTED: 'Çalışma yarıda kaldı',
  DATABASE_ERROR: 'Veritabanı hatası',
  APPLICATION_ERROR: 'Uygulama hatası',
  OVERDUE: 'Zamanında çalışmadı',
  SEND_FAILURES: 'E-posta gönderilemiyor',
};

export const OPS_ALERT_SEVERITY_LABELS: Record<OpsAlertView['severity'], string> = {
  WARNING: 'Uyarı',
  CRITICAL: 'Kritik',
};

export const OPS_ALERT_SEVERITY_BADGES: Record<OpsAlertView['severity'], string> = {
  WARNING: 'badge badge-warn',
  CRITICAL: 'badge badge-bad',
};

export const OPS_ALERT_RESOLUTION_TEXT: Record<string, string> = {
  RECOVERED: 'Düzeldi',
  DISABLED: 'İş kapatıldı',
  SUPERSEDED: 'Yeni bir hatayla değişti',
};

export const OPS_ALERT_CHANNEL_LABELS: Record<OpsAlertChannel, string> = { TELEGRAM: 'Telegram', EMAIL: 'E-posta' };

export const OPS_ALERT_DELIVERY_LABELS: Record<OpsAlertDeliveryStatus, string> = {
  PENDING: 'Bekliyor',
  SENDING: 'Gönderiliyor',
  SENT: 'Gönderildi',
  FAILED: 'Yeniden denenecek',
  ABANDONED: 'Gönderilemedi',
  CANCELLED: 'İptal (sorun gönderilmeden düzeldi)',
};

/** The e-mail error classes an e-mail alert is about, in the panel's words. */
const EMAIL_ERROR_TEXT: Record<string, string> = {
  TRANSPORT_UNAVAILABLE: 'Taşıma servisi kullanılamıyor',
  REJECTED: 'Sağlayıcı reddetti',
  TIMEOUT: 'Zaman aşımı',
  EMAIL_BRANDING_INCOMPLETE: 'Şirket ve e-posta ayarları eksik',
  EMAIL_PUBLIC_URL_INVALID: 'Public adres e-postada kullanılamaz',
  SOURCE_UNAVAILABLE: 'Kaynak kayıt yeniden oluşturulamıyor',
  UNKNOWN: 'Bilinmeyen hata',
};

export function opsAlertSubject(alert: Pick<OpsAlertView, 'source' | 'subjectKey'>): string {
  if (alert.source === 'EMAIL') return `E-posta · ${EMAIL_ERROR_TEXT[alert.subjectKey] ?? alert.subjectKey}`;
  return schedulerJobName(alert.subjectKey as SystemHealthJobKey);
}

/** The API row, as this panel's server measured it while fetching the report. */
export type ApiReachability = {
  status: HealthStatus;
  reason: 'OK' | 'REPORT_FAILED' | 'UNREACHABLE';
  latencyMs: number;
  checkedAt: string;
};

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  HEALTHY: 'Sağlıklı',
  DEGRADED: 'Sorunlu',
  DOWN: 'Çalışmıyor',
  UNKNOWN: 'Bilinmiyor',
};

export const HEALTH_STATUS_BADGES: Record<HealthStatus, string> = {
  HEALTHY: 'badge badge-good',
  DEGRADED: 'badge badge-warn',
  DOWN: 'badge badge-bad',
  UNKNOWN: 'badge badge-muted',
};

const SEVERITY: Record<HealthStatus, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

/** The API's own rule: the worst state wins, and nothing measured is UNKNOWN. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'UNKNOWN';
  return statuses.reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst));
}

export const ENVIRONMENT_LABELS: Record<AppEnvironment | 'unset', string> = {
  local: 'Yerel',
  staging: 'Staging',
  production: 'Production',
  unset: 'Belirtilmemiş',
};

export const ENVIRONMENT_BADGES: Record<AppEnvironment | 'unset', string> = {
  local: 'badge badge-muted',
  staging: 'badge badge-info',
  production: 'badge badge-info',
  unset: 'badge badge-muted',
};

/**
 * A job's own word, kept apart from the health scale: a job that failed, one
 * that is late and one that is switched off are three different situations,
 * and "Çalışmıyor" would blur the first two into an outage. The badge colour
 * still follows the job's real state, so three missed ticks stay red.
 */
export type JobState = 'OK' | 'RUNNING' | 'FAILED' | 'LATE' | 'OFF' | 'NO_DATA';

export const JOB_STATE_LABELS: Record<JobState, string> = {
  OK: 'Sağlıklı',
  RUNNING: 'Çalışıyor',
  FAILED: 'Başarısız',
  LATE: 'Gecikmiş',
  OFF: 'Kapalı',
  NO_DATA: 'Bilinmiyor',
};

export function jobState(job: Pick<SystemHealthJob, 'enabled' | 'reason'>): JobState {
  if (!job.enabled || job.reason === 'DISABLED') return 'OFF';
  switch (job.reason) {
    case 'LAST_RUN_SUCCEEDED':
      return 'OK';
    case 'RUNNING':
      return 'RUNNING';
    case 'OVERDUE':
      return 'LATE';
    case 'LAST_RUN_FAILED':
    case 'LAST_RUN_INTERRUPTED':
    case 'REPEATED_FAILURES':
      return 'FAILED';
    default:
      return 'NO_DATA';
  }
}

/**
 * The scheduler section's heading badge: how many running jobs failed or are
 * late, in the section's real colour — or the plain state when none are.
 */
export function schedulerSummaryLabel(
  section: Pick<SystemHealthReport['schedulers'], 'status' | 'reason' | 'jobs'>,
): string {
  if (section.reason === 'QUERY_FAILED') return HEALTH_STATUS_LABELS.UNKNOWN;
  const states = section.jobs.map(jobState);
  const failed = states.filter((state) => state === 'FAILED').length;
  const late = states.filter((state) => state === 'LATE').length;
  const parts = [failed ? `${failed} başarısız` : null, late ? `${late} gecikmiş` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : HEALTH_STATUS_LABELS[section.status];
}

export const PROBE_REASON_TEXT: Record<ProbeReason, string> = {
  OK: 'Beklenen yanıt geldi.',
  SLOW: 'Beklenen yanıt geldi ama 1 saniyeden yavaş.',
  UNEXPECTED_REDIRECT: 'Beklenen sayfa yerine yönlendirme döndü.',
  UNEXPECTED_STATUS: 'Yanıt verdi ama beklenen durum kodu değil.',
  SERVER_ERROR: 'Sunucu hata yanıtı verdi (5xx).',
  TIMEOUT: '1,5 saniye içinde yanıt vermedi.',
  UNREACHABLE: 'Bağlantı kurulamadı.',
  NOT_CONFIGURED: 'İç ağ adresi bu ortamda tanımlı değil; ölçülmüyor.',
  MISCONFIGURED: 'İç ağ adresi geçersiz; ölçülmüyor.',
};

export const DATABASE_REASON_TEXT: Record<SystemHealthReport['database']['reason'], string> = {
  OK: 'Hazırlık sorgusu yanıt verdi.',
  SLOW: 'Hazırlık sorgusu yanıt verdi ama 1 saniyeden yavaş.',
  TIMEOUT: 'Hazırlık sorgusu 2 saniye içinde yanıt vermedi.',
  UNREACHABLE: 'Veritabanına ulaşılamadı.',
};

export const API_REASON_TEXT: Record<ApiReachability['reason'], string> = {
  OK: 'Panel sunucusu API’ye iç ağdan ulaştı.',
  REPORT_FAILED: 'API yanıt veriyor ama sağlık raporunu üretemedi.',
  UNREACHABLE: 'Panel sunucusu API’ye ulaşamadı.',
};

export const SCHEDULER_REASON_TEXT: Record<SchedulerReason, string> = {
  DISABLED: 'Kapalı — ölçülmüyor.',
  NO_RECORDED_RUN: 'Açık ama henüz kayıtlı çalışması yok.',
  RUNNING: 'Şu anda çalışıyor.',
  LAST_RUN_SUCCEEDED: 'Son çalışma başarılı ve zamanında.',
  LAST_RUN_FAILED: 'Son çalışma hata verdi.',
  LAST_RUN_INTERRUPTED: 'Son çalışma yarıda kaldı (süreç durdu).',
  REPEATED_FAILURES: 'Son başarılı çalışmadan beri en az 3 kez hata verdi.',
  OVERDUE: 'Zamanı geçtiği hâlde çalışmadı.',
};

export const SCHEDULER_ERROR_TYPE_TEXT: Record<SchedulerErrorType, string> = {
  PROCESS_INTERRUPTED: 'Süreç durdu',
  DATABASE_ERROR: 'Veritabanı hatası',
  APPLICATION_ERROR: 'Uygulama hatası',
};

export const EMAIL_REASON_TEXT: Record<EmailReason, string> = {
  OK: 'E-postalar gönderiliyor.',
  NO_TRAFFIC: 'Son 24 saatte tamamlanan gönderim yok; ölçülecek veri yok.',
  FAILURES: 'Gönderimlerin en az %10’u başarısız.',
  MOSTLY_FAILING: 'Gönderimlerin en az yarısı başarısız.',
  STUCK_PENDING: '15 dakikadan uzun bekleyen gönderim var.',
  QUERY_FAILED: 'Bildirim kayıtları okunamadı.',
};

export const NOT_MEASURED_TEXT: Record<SystemHealthReport['notMeasured'][number], { name: string; note: string }> = {
  EXTERNAL_UPTIME: {
    name: 'Dışarıdan erişilebilirlik',
    note: 'Harici uptime izleme kurulu değil (Faz 2). Bu ekrandaki web/admin kontrolleri iç ağdandır.',
  },
  BACKUPS: { name: 'Otomatik yedekleme', note: 'Yedekleme kaydı bu ekrana bağlı değil (Faz 2).' },
  HOST_RESOURCES: { name: 'Sunucu CPU / bellek / disk', note: 'Ölçülmüyor (Faz 2).' },
  CAMPAIGN_EVALUATION_WORKER: {
    name: 'Kampanya değerlendirme işçisi',
    note: 'Çalışma kaydı tutmuyor; durumu bu ekrandan ölçülemez.',
  },
};

export function schedulerJobName(key: SystemHealthJobKey): string {
  if (key === 'seo-not-found-retention') return '404 önerisi temizliği (SEO)';
  return SCHEDULER_JOB_COPY[key]?.name ?? key;
}

/**
 * The API row from the report fetch: answered → HEALTHY, answered with a
 * failure → DEGRADED (the API is up, its report is not), no answer → DOWN.
 */
export function apiReachability(
  outcome: 'ok' | 'report-failed' | 'unreachable',
  latencyMs: number,
  checkedAt: string,
): ApiReachability {
  if (outcome === 'ok') return { status: 'HEALTHY', reason: 'OK', latencyMs, checkedAt };
  if (outcome === 'report-failed') return { status: 'DEGRADED', reason: 'REPORT_FAILED', latencyMs, checkedAt };
  return { status: 'DOWN', reason: 'UNREACHABLE', latencyMs, checkedAt };
}

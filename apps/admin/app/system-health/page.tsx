import Link from 'next/link';
import { DataTable, type DataColumn } from '../../components/data-table';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';
import { StatCard } from '../../components/stat-card';
import {
  ApiError,
  apiFetch,
  formatDateTime,
  formatTime,
  notificationTemplateLabel,
  requireAdmin,
} from '../../lib/api';
import { rethrowNextControlFlow } from '../../lib/next-control-flow';
import {
  API_REASON_TEXT,
  type ApiReachability,
  DATABASE_REASON_TEXT,
  EMAIL_REASON_TEXT,
  HEALTH_STATUS_BADGES,
  HEALTH_STATUS_LABELS,
  type HealthStatus,
  NOT_MEASURED_TEXT,
  PROBE_REASON_TEXT,
  SCHEDULER_ERROR_TYPE_TEXT,
  SCHEDULER_REASON_TEXT,
  type SystemHealthReport,
  apiReachability,
  schedulerJobName,
  worstStatus,
} from '../../lib/system-health';
import { HealthRefresh } from './health-refresh';

/**
 * ADMIN-SYSTEM-HEALTH-001 — "Sistem sağlığı".
 *
 * A read-only screen: it restarts, triggers and retries nothing, and links
 * only to screens that already exist. OPERATIONS_SETTINGS_READ opens it; the
 * e-mail section is drawn only when the API sent it, which it does for a
 * NOTIFICATION_LOGS_READ holder alone.
 *
 * Every state comes from the API's rules except the API's own row, which
 * this panel's server measures by fetching the report: the API is never
 * asked whether the API is up.
 */

export const dynamic = 'force-dynamic';

/** The report fetch gives up after this; the API's own probes finish well inside it. */
const REPORT_TIMEOUT_MS = 8_000;

const SERVICE_COLUMNS: DataColumn[] = [
  { key: 'name', label: 'Bileşen' },
  { key: 'status', label: 'Durum' },
  { key: 'detail', label: 'Açıklama' },
  { key: 'latency', label: 'Yanıt süresi', align: 'end' },
  { key: 'checkedAt', label: 'Son kontrol' },
];

const JOB_COLUMNS: DataColumn[] = [
  { key: 'name', label: 'İş' },
  { key: 'status', label: 'Durum' },
  { key: 'detail', label: 'Açıklama' },
  { key: 'lastRun', label: 'Son çalışma' },
  { key: 'lastSuccess', label: 'Son başarılı' },
  { key: 'day', label: '24 saat (başarılı / hatalı)', align: 'end' },
  { key: 'cron', label: 'Zamanlama' },
];

const FAILURE_COLUMNS: DataColumn[] = [
  { key: 'at', label: 'Zaman' },
  { key: 'source', label: 'Kaynak' },
  { key: 'subject', label: 'İş / şablon' },
  { key: 'type', label: 'Hata türü' },
];

const SCREEN_INFO = (
  <>
    Platformun bileşenlerini ölçülebilen verilerle gösterir: Sağlıklı, Sorunlu, Çalışmıyor ya da Bilinmiyor.
    Ölçülemeyen bir şey hiçbir zaman Sağlıklı gösterilmez. Web ve admin kontrolleri sunucunun iç ağından yapılır;
    dışarıdan erişilebilirliği (uptime) göstermez. Bu ekran hiçbir işi başlatmaz, durdurmaz ya da yeniden denemez.
  </>
);

function StatusBadge({ status, testId }: { status: HealthStatus; testId?: string }) {
  return (
    <span className={HEALTH_STATUS_BADGES[status]} data-testid={testId} data-status={status}>
      {HEALTH_STATUS_LABELS[status]}
    </span>
  );
}

function latency(ms: number | null): string {
  return ms === null ? '—' : `${ms} ms`;
}

async function loadReport(): Promise<{ report: SystemHealthReport | null; api: ApiReachability }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const report = await apiFetch<SystemHealthReport>('/system-health', {
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    return { report, api: apiReachability('ok', elapsed(), new Date().toISOString()) };
  } catch (error) {
    rethrowNextControlFlow(error);
    const outcome = error instanceof ApiError ? 'report-failed' : 'unreachable';
    return { report: null, api: apiReachability(outcome, elapsed(), new Date().toISOString()) };
  }
}

export default async function SystemHealthPage() {
  await requireAdmin('OPERATIONS_SETTINGS_READ');
  const { report, api } = await loadReport();

  const overall = report ? worstStatus([api.status, report.overall]) : worstStatus([api.status, 'UNKNOWN']);
  const generatedAtLabel = formatTime(report?.generatedAt ?? api.checkedAt);

  const failures = [
    ...(report?.schedulers.recentFailures ?? []).map((failure) => ({
      key: `job-${failure.jobKey}-${failure.at}`,
      at: failure.at,
      source: 'Zamanlanmış iş',
      subject: schedulerJobName(failure.jobKey),
      href: null as string | null,
      type: SCHEDULER_ERROR_TYPE_TEXT[failure.errorType],
    })),
    ...(report?.email?.recentFailures ?? []).map((failure) => ({
      key: `mail-${failure.id}`,
      at: failure.at,
      source: 'E-posta',
      subject: notificationTemplateLabel(failure.template),
      href: `/notifications/${encodeURIComponent(failure.id)}`,
      type: failure.errorLabel ?? 'Bilinmeyen hata',
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 15);

  return (
    <main className="system-health-page">
      <PageHeader
        title="Sistem sağlığı"
        subtitle={
          <>
            Genel durum: <StatusBadge status={overall} testId="system-health-overall" />
          </>
        }
        info={SCREEN_INFO}
        actions={<HealthRefresh generatedAtLabel={generatedAtLabel} />}
      />

      <div className="notice notice-info" data-testid="system-health-scope">
        Web ve admin kontrolleri sunucunun iç ağından yapılır ve yalnız uygulamanın yanıt verdiğini gösterir;
        kullanıcıların siteye dışarıdan erişebildiği anlamına gelmez.
      </div>

      {report ? null : (
        <div className="notice notice-error" role="alert" data-testid="system-health-unavailable">
          {API_REASON_TEXT[api.reason]} Diğer bileşenler bu yüzden ölçülemedi.
        </div>
      )}

      <div className="settings-stack">
        <SectionCard title="Servisler" subtitle="API, veritabanı, web ve admin paneli." padded={false} testId="system-health-services">
          <DataTable caption="Servis durumları" columns={SERVICE_COLUMNS} minWidth={720} testId="system-health-service-table">
            <tr data-testid="system-health-row-api">
              <td>API</td>
              <td>
                <StatusBadge status={api.status} />
              </td>
              <td>{API_REASON_TEXT[api.reason]} Dış uptime değildir.</td>
              <td className="is-num">{latency(api.latencyMs)}</td>
              <td>{formatDateTime(api.checkedAt)}</td>
            </tr>
            {report ? (
              <>
                <tr data-testid="system-health-row-database">
                  <td>PostgreSQL</td>
                  <td>
                    <StatusBadge status={report.database.status} />
                  </td>
                  <td>
                    {DATABASE_REASON_TEXT[report.database.reason]}
                    {report.database.appliedMigrations !== null
                      ? ` Uygulanmış migration: ${report.database.appliedMigrations}.`
                      : ''}
                  </td>
                  <td className="is-num">{latency(report.database.latencyMs)}</td>
                  <td>{formatDateTime(report.database.checkedAt)}</td>
                </tr>
                <tr data-testid="system-health-row-web">
                  <td>Web sitesi (iç ağ)</td>
                  <td>
                    <StatusBadge status={report.web.status} />
                  </td>
                  <td>{PROBE_REASON_TEXT[report.web.reason]}</td>
                  <td className="is-num">{latency(report.web.latencyMs)}</td>
                  <td>{formatDateTime(report.web.checkedAt)}</td>
                </tr>
                <tr data-testid="system-health-row-admin">
                  <td>Admin paneli (iç ağ)</td>
                  <td>
                    <StatusBadge status={report.admin.status} />
                  </td>
                  <td>{PROBE_REASON_TEXT[report.admin.reason]}</td>
                  <td className="is-num">{latency(report.admin.latencyMs)}</td>
                  <td>{formatDateTime(report.admin.checkedAt)}</td>
                </tr>
              </>
            ) : null}
          </DataTable>
        </SectionCard>

        {report ? (
          <SectionCard
            title={
              <>
                Zamanlanmış işler <StatusBadge status={report.schedulers.status} testId="system-health-schedulers-status" />
              </>
            }
            subtitle={
              report.schedulers.reason === 'QUERY_FAILED'
                ? 'Çalışma kayıtları okunamadı.'
                : `Kapalı işler genel duruma katılmaz. Son kontrol ${formatDateTime(report.schedulers.checkedAt)}.`
            }
            actions={
              <Link className="btn btn-secondary btn-sm" href="/operations-settings">
                Operasyon ayarları
              </Link>
            }
            padded={false}
            testId="system-health-schedulers"
          >
            <DataTable caption="Zamanlanmış iş durumları" columns={JOB_COLUMNS} testId="system-health-job-table">
              {report.schedulers.jobs.map((job) => (
                <tr key={job.key} data-testid={`system-health-job-${job.key}`}>
                  <td>{schedulerJobName(job.key)}</td>
                  <td>
                    {job.enabled ? <StatusBadge status={job.status} /> : <span className="badge badge-muted">Kapalı</span>}
                  </td>
                  <td>
                    {SCHEDULER_REASON_TEXT[job.reason]}
                    {job.reason === 'OVERDUE'
                      ? ` Kaçırılan çalışma: ${job.missedTicks >= 3 ? '3 veya daha fazla' : job.missedTicks}.`
                      : ''}
                  </td>
                  <td>
                    {job.lastRun
                      ? `${formatDateTime(job.lastRun.startedAt)}${
                          job.lastRun.errorType ? ` · ${SCHEDULER_ERROR_TYPE_TEXT[job.lastRun.errorType]}` : ''
                        }`
                      : 'Kayıt yok'}
                  </td>
                  <td>{job.lastSuccessAt ? formatDateTime(job.lastSuccessAt) : 'Kayıt yok'}</td>
                  <td className="is-num">
                    {job.last24h.succeeded} / {job.last24h.failed}
                  </td>
                  <td>
                    <code>{job.cron}</code>
                  </td>
                </tr>
              ))}
            </DataTable>
          </SectionCard>
        ) : null}

        {report?.email ? (
          <SectionCard
            title={
              <>
                E-posta bildirimleri <StatusBadge status={report.email.status} testId="system-health-email-status" />
              </>
            }
            subtitle={`${EMAIL_REASON_TEXT[report.email.reason]} Son ${report.email.windowHours} saat · son kontrol ${formatDateTime(
              report.email.checkedAt,
            )}.`}
            actions={
              <Link className="btn btn-secondary btn-sm" href="/notifications?channel=EMAIL">
                Gönderilen bildirimler
              </Link>
            }
            testId="system-health-email"
          >
            {report.email.counts ? (
              <div className="stat-grid">
                <StatCard label="Gönderildi (SENT)" value={report.email.counts.sent} metricKey="email-sent" />
                <StatCard
                  label="Başarısız (FAILED)"
                  value={report.email.counts.failed}
                  tone={report.email.counts.failed > 0 ? 'error' : 'neutral'}
                  metricKey="email-failed"
                />
                <StatCard label="Bekleyen (PENDING)" value={report.email.counts.pending} metricKey="email-pending" />
                <StatCard
                  label="15 dk’dan uzun bekleyen"
                  value={report.email.counts.stuckPending}
                  tone={report.email.counts.stuckPending > 0 ? 'warning' : 'neutral'}
                  metricKey="email-stuck"
                />
              </div>
            ) : null}
            <p className="muted">
              Son başarılı gönderim: {report.email.lastSentAt ? formatDateTime(report.email.lastSentAt) : 'kayıt yok'}
            </p>
          </SectionCard>
        ) : report ? (
          <p className="muted" data-testid="system-health-email-hidden">
            E-posta bildirim sayıları, bildirim kayıtlarını görme yetkisi olan hesaplara gösterilir.
          </p>
        ) : null}

        {report ? (
          <SectionCard
            title="Son başarısız işlemler"
            subtitle={
              report.email
                ? 'Son 7 gün · zamanlanmış işler ve e-postalar. Hata ayrıntısı değil, yalnız türü gösterilir.'
                : 'Son 7 gün · zamanlanmış işler. Hata ayrıntısı değil, yalnız türü gösterilir.'
            }
            padded={failures.length === 0}
            testId="system-health-failures"
          >
            {failures.length === 0 ? (
              <p className="muted">Son 7 günde kayıtlı başarısız işlem yok.</p>
            ) : (
              <DataTable caption="Son başarısız işlemler" columns={FAILURE_COLUMNS} minWidth={640} testId="system-health-failure-table">
                {failures.map((failure) => (
                  <tr key={failure.key}>
                    <td>{formatDateTime(failure.at)}</td>
                    <td>{failure.source}</td>
                    <td>{failure.href ? <Link href={failure.href}>{failure.subject}</Link> : failure.subject}</td>
                    <td>{failure.type}</td>
                  </tr>
                ))}
              </DataTable>
            )}
          </SectionCard>
        ) : null}

        <SectionCard
          title="Ölçülmeyenler"
          subtitle="Bu sürümde ölçülmeyen kaynaklar. Durumları bilinmiyor; sağlıklı sayılmaz."
          testId="system-health-not-measured"
        >
          <ul className="system-health-not-measured">
            {(report?.notMeasured ?? (Object.keys(NOT_MEASURED_TEXT) as SystemHealthReport['notMeasured'])).map((key) => (
              <li key={key}>
                <StatusBadge status="UNKNOWN" /> <strong>{NOT_MEASURED_TEXT[key].name}</strong> — {NOT_MEASURED_TEXT[key].note}
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </main>
  );
}

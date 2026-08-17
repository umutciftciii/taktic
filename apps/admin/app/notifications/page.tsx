import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TEMPLATES,
  NotificationChannel,
  NotificationLogEntry,
  NotificationLogResponse,
  NotificationStatus,
  notificationChannelLabel,
  notificationStatusBadgeClass,
  notificationStatusLabel,
  notificationTemplateLabel,
  requireAdmin,
} from '../../lib/api';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

/**
 * Read-only delivery history.
 *
 * The screen answers one question — what did the platform try to send, to whom
 * (masked), when, and how did it end — and offers no way to act on the answer.
 * There is deliberately no resend, retry, delete or status-edit control: a
 * one-time code cannot be re-sent from an audit row (the code is not stored, by
 * design), and a row that could be edited would stop being an audit trail.
 */

const DEFAULT_PAGE_SIZE = 50;

type RawSearchParams = {
  status?: string;
  channel?: string;
  template?: string;
  requestId?: string;
  userId?: string;
  from?: string;
  to?: string;
  page?: string;
};

type AdminNotificationsPageProps = {
  searchParams: Promise<RawSearchParams>;
};

function normalizeStatus(value: string | undefined): NotificationStatus | '' {
  if (!value) return '';
  const upper = value.toUpperCase();
  return (NOTIFICATION_STATUSES as readonly string[]).includes(upper)
    ? (upper as NotificationStatus)
    : '';
}

function normalizeChannel(value: string | undefined): NotificationChannel | '' {
  if (!value) return '';
  const upper = value.toUpperCase();
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(upper)
    ? (upper as NotificationChannel)
    : '';
}

function normalizeDate(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : '';
}

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) continue;
    query.set(key, String(value));
  }
  const str = query.toString();
  return str ? `?${str}` : '';
}

function buildPageHref(
  baseParams: Record<string, string | number | undefined>,
  page: number,
): string {
  const params = { ...baseParams };
  if (page <= 1) delete params.page;
  else params.page = page;
  return `/notifications${buildQueryString(params)}`;
}

/**
 * The date inputs give a civil day; the operator means their own day. Anchored
 * to Europe/Istanbul so "today" matches the rest of the admin surface.
 */
function formatRangeDateForApi(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  return `${value}${endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00'}`;
}

export default async function AdminNotificationsPage({
  searchParams,
}: AdminNotificationsPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const status = normalizeStatus(params.status);
  const channel = normalizeChannel(params.channel);
  const template = (params.template ?? '').trim();
  const requestId = (params.requestId ?? '').trim();
  const userId = (params.userId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = normalizePage(params.page);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  if (status) apiQuery.set('status', status);
  if (channel) apiQuery.set('channel', channel);
  if (template) apiQuery.set('template', template);
  if (requestId) apiQuery.set('requestId', requestId);
  if (userId) apiQuery.set('userId', userId);
  const fromIso = formatRangeDateForApi(from, false);
  const toIso = formatRangeDateForApi(to, true);
  if (fromIso) apiQuery.set('from', fromIso);
  if (toIso) apiQuery.set('to', toIso);

  const response = await apiFetch<NotificationLogResponse>(
    `/notification-logs?${apiQuery.toString()}`,
  );

  const hasFilters = Boolean(status || channel || template || requestId || userId || from || to);
  const baseParams = { status, channel, template, requestId, userId, from, to };

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  // A stored template no longer in this build must stay selectable, or applying
  // the filter would silently drop it on the next submit.
  const templateOptions = (NOTIFICATION_TEMPLATES as readonly string[]).includes(template)
    ? [...NOTIFICATION_TEMPLATES]
    : template
      ? [...NOTIFICATION_TEMPLATES, template]
      : [...NOTIFICATION_TEMPLATES];

  return (
    <main>
      <PageHeader
        title="Bildirim Geçmişi"
        subtitle="Platformun gönderdiği e-posta ve SMS denemelerinin denetim kaydı. Yalnız görüntülenir."
      />

      <form className="admin-toolbar" method="get" action="/notifications">
        <div className="admin-toolbar-field">
          <label htmlFor="notification-status">Durum</label>
          <select id="notification-status" name="status" defaultValue={status}>
            <option value="">Tümü</option>
            {NOTIFICATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {notificationStatusLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-channel">Kanal</label>
          <select id="notification-channel" name="channel" defaultValue={channel}>
            <option value="">Tümü</option>
            {NOTIFICATION_CHANNELS.map((value) => (
              <option key={value} value={value}>
                {notificationChannelLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-template">Şablon</label>
          <select id="notification-template" name="template" defaultValue={template}>
            <option value="">Tümü</option>
            {templateOptions.map((value) => (
              <option key={value} value={value}>
                {notificationTemplateLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-from">Başlangıç</label>
          <input id="notification-from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-to">Bitiş</label>
          <input id="notification-to" name="to" type="date" defaultValue={to} />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-request-id">Talep ID</label>
          <input
            id="notification-request-id"
            name="requestId"
            type="search"
            placeholder="Talep kimliği"
            defaultValue={requestId}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="notification-user-id">Kullanıcı ID</label>
          <input
            id="notification-user-id"
            name="userId"
            type="search"
            placeholder="Kullanıcı kimliği"
            defaultValue={userId}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary" data-testid="notification-count">
            {response.total === 0 ? '0 kayıt' : `${startIndex}-${endIndex} / ${response.total} kayıt`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/notifications">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Gönderim kayıtları"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} kayıt/sayfa · en yeni önce`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun bildirim kaydı bulunamadı.'
                : 'Henüz bildirim gönderilmedi.'
            }
            description={
              hasFilters
                ? 'Filtreleri daraltabilir veya temizleyebilirsiniz.'
                : 'Hesap etkinleştirme, telefon doğrulama veya talep hatırlatma gönderildiğinde burada görünür.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/notifications">
                  Filtreleri temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="notification-table">
              <thead>
                <tr>
                  <th>Oluşturulma</th>
                  <th>Kanal</th>
                  <th>Şablon</th>
                  <th>Alıcı (maskeli)</th>
                  <th>Durum</th>
                  <th>Hata sınıfı</th>
                  <th>Sonuç zamanı</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {response.items.map((entry) => (
                  <NotificationRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav className="inline-actions" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          {response.page > 1 ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page - 1)}
            >
              ← Önceki
            </Link>
          ) : (
            <span />
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Sayfa {response.page}
          </span>
          {response.hasNextPage ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page + 1)}
            >
              Sonraki →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}

function NotificationRow({ entry }: { entry: NotificationLogEntry }) {
  const outcomeAt = entry.sentAt ?? entry.failedAt;

  return (
    <tr data-testid="notification-row" data-status={entry.status} data-channel={entry.channel}>
      <td>{formatDateTime(entry.createdAt)}</td>
      <td>
        <span className="badge badge-muted">{notificationChannelLabel(entry.channel)}</span>
      </td>
      <td>{notificationTemplateLabel(entry.template)}</td>
      <td>
        <code style={{ fontSize: 12 }}>{entry.maskedRecipient}</code>
      </td>
      <td>
        <span className={notificationStatusBadgeClass(entry.status)}>
          {notificationStatusLabel(entry.status)}
        </span>
      </td>
      <td>
        {/*
          The API's own label for the failure class. The provider's error text
          never leaves the API process — it can contain the address or the body.
        */}
        {entry.errorLabel ? (
          <span className="cell-muted" data-testid="notification-error-label">
            {entry.errorLabel}
          </span>
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td>{outcomeAt ? formatDateTime(outcomeAt) : <span className="cell-muted">-</span>}</td>
      <td>
        <Link className="btn btn-ghost btn-sm" href={`/notifications/${entry.id}`}>
          Detay
        </Link>
      </td>
    </tr>
  );
}

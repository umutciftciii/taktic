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
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { NotificationRetryButton } from '../../components/notification-retry-button';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';

/**
 * Delivery history — "Gönderilen bildirimler" (#46), the reference screen for
 * the shared list components (ADMIN-DESIGN-001 Faz 2, design `list:notifications`).
 *
 * The screen answers one question — what did the platform try to send, to whom
 * (masked), when, and how did it end — and offers exactly one action on the
 * answer: re-sending a failed message that the server can compose again from
 * live domain data.
 *
 * Everything else it still refuses. Nothing here can be deleted, edited or
 * re-classified, or an audit trail would stop being one. And the retry control
 * appears only where the API marked the row retryable *and* this session holds
 * NOTIFICATION_RETRY: a mail that carried a one-time token cannot be re-sent
 * from an audit row, because the token was never stored — the user has to ask
 * for a new one.
 *
 * Every piece of list state is in the URL: the saved view and the eight
 * filters are the same query parameters the API takes, and the page number
 * rides along with them.
 */

const PATH = '/notifications';
const DEFAULT_PAGE_SIZE = 50;

/** The design's ⓘ text for this screen, as written — it matches the API's rules. */
const SCREEN_INFO =
  'Platformun gönderdiği e-posta ve SMS denemelerinin kaydı. Bu liste silinemez ve düzenlenemez — neyin gönderildiğinin kanıtıdır. Yalnızca başarısız olan ve yeniden oluşturulabilen e-postalar tekrar gönderilebilir; şifre sıfırlama gibi tek kullanımlık bağlantı taşıyanlar gönderilemez, kullanıcının yeniden talep etmesi gerekir.';

const COLUMNS: DataColumn[] = [
  // The design's own name for this column. "Oluşturulma" is one unbreakable
  // word that alone held the table 31px wider than its box at 1440px under the
  // CI's DejaVu Sans; "Zaman" lets the column shrink to its dates.
  { key: 'createdAt', label: 'Zaman' },
  { key: 'channel', label: 'Kanal' },
  { key: 'template', label: 'Şablon' },
  { key: 'recipient', label: 'Alıcı (maskeli)' },
  { key: 'attempts', label: 'Deneme', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'error', label: 'Hata sınıfı' },
  { key: 'outcomeAt', label: 'Sonuç zamanı' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

type RawSearchParams = {
  status?: string;
  channel?: string;
  template?: string;
  requestId?: string;
  userId?: string;
  providerId?: string;
  from?: string;
  to?: string;
  page?: string;
  /** Set by the retry action's redirect; see app/notifications/actions.ts. */
  retry?: string;
  message?: string;
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

/**
 * The date inputs give a civil day; the operator means their own day. Anchored
 * to Europe/Istanbul so "today" matches the rest of the admin surface.
 */
function formatRangeDateForApi(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  return `${value}${endOfDay ? 'T23:59:59.999+03:00' : 'T00:00:00.000+03:00'}`;
}

/** The saved views are the status filter's values, in the order an operator checks them. */
const VIEW_STATUSES: NotificationStatus[] = ['FAILED', 'PENDING', 'SENT'];

export default async function AdminNotificationsPage({
  searchParams,
}: AdminNotificationsPageProps) {
  const { can } = await requireAdmin('NOTIFICATION_LOGS_READ');
  // The retry route asks for its own permission. It is decided here, on the
  // server, and only its answer reaches the rows: a row shows the button when
  // the API calls it retryable *and* this session may retry.
  const canRetry = can('NOTIFICATION_RETRY');

  const params = await searchParams;
  const status = normalizeStatus(params.status);
  const channel = normalizeChannel(params.channel);
  const template = (params.template ?? '').trim();
  const requestId = (params.requestId ?? '').trim();
  const userId = (params.userId ?? '').trim();
  const providerId = (params.providerId ?? '').trim();
  const from = normalizeDate(params.from);
  const to = normalizeDate(params.to);
  const page = parsePage(params.page);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  if (status) apiQuery.set('status', status);
  if (channel) apiQuery.set('channel', channel);
  if (template) apiQuery.set('template', template);
  if (requestId) apiQuery.set('requestId', requestId);
  if (userId) apiQuery.set('userId', userId);
  if (providerId) apiQuery.set('providerId', providerId);
  const fromIso = formatRangeDateForApi(from, false);
  const toIso = formatRangeDateForApi(to, true);
  if (fromIso) apiQuery.set('from', fromIso);
  if (toIso) apiQuery.set('to', toIso);

  const response = await apiFetch<NotificationLogResponse>(
    `/notification-logs?${apiQuery.toString()}`,
  );

  const hasFilters = Boolean(
    status || channel || template || requestId || userId || providerId || from || to,
  );
  const filterParams: QueryParams = { status, channel, template, requestId, userId, providerId, from, to };
  // Where a retry sends the operator back to: this exact view, page included.
  const currentHref = buildHref(PATH, filterParams, { page: page > 1 ? page : undefined });

  // A stored template no longer in this build must stay selectable, or applying
  // the filter would silently drop it on the next submit.
  const templateOptions = (NOTIFICATION_TEMPLATES as readonly string[]).includes(template)
    ? [...NOTIFICATION_TEMPLATES]
    : template
      ? [...NOTIFICATION_TEMPLATES, template]
      : [...NOTIFICATION_TEMPLATES];

  // Only the open view's total is known without another request, so only it
  // carries a counter.
  const views: TabItem[] = [
    { key: '', label: 'Tümü', testId: 'notification-view-all' },
    ...VIEW_STATUSES.map((value) => ({
      key: value,
      label: notificationStatusLabel(value),
      testId: `notification-view-${value.toLowerCase()}`,
    })),
  ].map((view) => (view.key === status ? { ...view, count: response.total } : view));

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Filtreye uyan kayıt yok'
        : 'Henüz kayıt yok'
      : `${hasFilters ? 'Filtreye uyan ' : ''}${formatCount(response.total)} kayıt · en yeni önce`;

  return (
    <main className="notifications-page">
      <PageHeader title="Gönderilen bildirimler" subtitle={summary} info={SCREEN_INFO} />

      {params.retry === 'sent' ? (
        <div className="notice notice-success" role="status" data-testid="notification-retry-result">
          Bildirim yeniden gönderildi.
        </div>
      ) : params.retry ? (
        <div className="notice notice-error" role="alert" data-testid="notification-retry-result">
          {params.retry === 'failed'
            ? 'Yeniden gönderim denendi ancak başarısız oldu. Kaydın hata sınıfına bakın.'
            : params.message || 'Yeniden gönderim başlatılamadı.'}
        </div>
      ) : null}

      <SavedViewTabs
        label="Bildirim görünümleri"
        items={views}
        active={status}
        path={PATH}
        params={filterParams}
        param="status"
        testId="notification-views"
      />

      <FilterBar
        // A new filter state is a new form: the fields are uncontrolled, and a
        // saved view or "Temizle" arrives as a client-side navigation that
        // would otherwise leave them showing the previous values.
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Bildirim filtreleri"
        testId="notification-filters"
      >
        <FilterField label="Durum" htmlFor="notification-status">
          <select id="notification-status" name="status" defaultValue={status}>
            <option value="">Tümü</option>
            {NOTIFICATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {notificationStatusLabel(value)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Kanal" htmlFor="notification-channel">
          <select id="notification-channel" name="channel" defaultValue={channel}>
            <option value="">Tümü</option>
            {NOTIFICATION_CHANNELS.map((value) => (
              <option key={value} value={value}>
                {notificationChannelLabel(value)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Şablon" htmlFor="notification-template" wide>
          <select id="notification-template" name="template" defaultValue={template}>
            <option value="">Tümü</option>
            {templateOptions.map((value) => (
              <option key={value} value={value}>
                {notificationTemplateLabel(value)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="notification-from">
          <input id="notification-from" name="from" type="date" defaultValue={from} />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="notification-to">
          <input id="notification-to" name="to" type="date" defaultValue={to} />
        </FilterField>
        <FilterField label="Talep ID" htmlFor="notification-request-id">
          <input
            id="notification-request-id"
            name="requestId"
            type="search"
            placeholder="Talep kimliği"
            defaultValue={requestId}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Kullanıcı ID" htmlFor="notification-user-id">
          <input
            id="notification-user-id"
            name="userId"
            type="search"
            placeholder="Kullanıcı kimliği"
            defaultValue={userId}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Hizmet veren ID" htmlFor="notification-provider-id">
          <input
            id="notification-provider-id"
            name="providerId"
            type="search"
            placeholder="Hizmet veren kimliği"
            defaultValue={providerId}
            autoComplete="off"
          />
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
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
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Gönderim kayıtları" columns={COLUMNS} testId="notification-table">
            {response.items.map((entry) => (
              <NotificationRow key={entry.id} entry={entry} canRetry={canRetry} returnTo={currentHref} />
            ))}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            summaryTestId="notification-count"
          />
        ) : null}
      </div>
    </main>
  );
}

/** A masked address may break after its "@", and nowhere else. */
function MaskedRecipient({ value }: { value: string }) {
  const at = value.indexOf('@');
  if (at <= 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, at + 1)}
      <wbr />
      {value.slice(at + 1)}
    </>
  );
}

function NotificationRow({
  entry,
  canRetry,
  returnTo,
}: {
  entry: NotificationLogEntry;
  canRetry: boolean;
  returnTo: string;
}) {
  const outcomeAt = entry.sentAt ?? entry.failedAt;

  return (
    <tr data-testid="notification-row" data-status={entry.status} data-channel={entry.channel}>
      <td>{formatDateTime(entry.createdAt)}</td>
      <td>
        <span className="badge badge-muted">{notificationChannelLabel(entry.channel)}</span>
      </td>
      <td>{notificationTemplateLabel(entry.template)}</td>
      <td>
        <code className="notification-recipient">
          <MaskedRecipient value={entry.maskedRecipient} />
        </code>
      </td>
      <td className="is-num">{entry.attemptCount}</td>
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
      <td>
        {outcomeAt ? formatDateTime(outcomeAt) : <span className="cell-muted">-</span>}
      </td>
      <td className="col-actions">
        <div className="inline-actions">
          {/* Only for rows the API itself calls retryable, and only with NOTIFICATION_RETRY. */}
          {entry.retryable && canRetry ? (
            <NotificationRetryButton id={entry.id} returnTo={returnTo} />
          ) : null}
          <Link
            className="btn btn-secondary btn-sm"
            href={`/notifications/${entry.id}`}
            aria-label={`Aç: ${notificationTemplateLabel(entry.template)}, ${formatDateTime(entry.createdAt)}`}
          >
            Aç
          </Link>
        </div>
      </td>
    </tr>
  );
}

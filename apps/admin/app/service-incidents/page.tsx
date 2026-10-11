import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import {
  INCIDENT_DECISION_LABELS,
  PROVIDER_INCIDENT_STATUS_LABELS,
  PROVIDER_INCIDENT_STATUSES,
  RELIABILITY_LEVEL_LABELS,
  RELIABILITY_LEVELS,
  SERVICE_ISSUE_REASON_LABELS,
  SERVICE_ISSUE_REASONS,
  incidentStatusBadgeClass,
  reliabilityLevelBadgeClass,
  type ProviderIncidentStatus,
  type ReliabilityLevel,
  type ServiceIncidentListItem,
  type ServiceIncidentListResponse,
  type ServiceIssueReason,
} from '../../lib/service-incidents';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';

type PageProps = {
  searchParams: Promise<{
    status?: string;
    reason?: string;
    providerId?: string;
    from?: string;
    to?: string;
    response?: string;
    overdue?: string;
    risk?: string;
    page?: string;
  }>;
};

const PATH = '/service-incidents';
const PAGE_SIZE = 25;
const STATES = ['open', 'decided', 'all', ...PROVIDER_INCIDENT_STATUSES] as const;
type State = (typeof STATES)[number];

const SCREEN_INFO =
  'Müşterilerin eşleştikleri hizmet veren hakkında bildirdiği hizmet aksaklıkları. Varsayılan görünüm karar bekleyenleri en eskisi başta gösterir. Hizmet verenin 72 saatlik yanıt süresi yalnız bir sinyaldir; karar vermeyi engellemez. Bir karar kredi iadesi yapmaz ve hizmet verenin bu talepten dışlanmasını değiştirmez.';

const COLUMNS: DataColumn[] = [
  { key: 'incident', label: 'Bildirim' },
  { key: 'reported', label: 'Bildirildi' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'request', label: 'Talep' },
  { key: 'reason', label: 'Neden' },
  { key: 'status', label: 'Durum' },
  { key: 'response', label: 'Yanıt' },
  { key: 'decision', label: 'Karar' },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | '' {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

/**
 * REL-002 Faz 4 — the service incident queue (`GET /admin/service-incidents`).
 *
 * Every filter is the API's own query parameter, in the URL. The default view
 * is "Açık" (REPORTED + PROVIDER_RESPONDED), oldest first — the API's order,
 * not re-sorted here. Links to a request or a provider are drawn only where the
 * session may open them.
 */
export default async function ServiceIncidentsPage({ searchParams }: PageProps) {
  const { can } = await requireAdmin('SERVICE_INCIDENTS_READ');
  const canOpenRequest = can('REQUESTS_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const params = await searchParams;

  const state: State = pick(params.status, STATES) || 'open';
  const reason = pick<ServiceIssueReason>(params.reason, SERVICE_ISSUE_REASONS);
  const response = pick(params.response, ['responded', 'not_responded'] as const);
  const overdue = pick(params.overdue, ['true'] as const);
  const risk = pick<ReliabilityLevel>(params.risk, RELIABILITY_LEVELS);
  const providerId = /^[\w-]{1,64}$/.test(params.providerId ?? '') ? params.providerId! : '';
  const from = ISO_DATE.test(params.from ?? '') ? params.from! : '';
  const to = ISO_DATE.test(params.to ?? '') ? params.to! : '';
  const page = parsePage(params.page);

  const query = new URLSearchParams({ status: state, page: String(page), pageSize: String(PAGE_SIZE) });
  if (reason) query.set('reason', reason);
  if (providerId) query.set('providerId', providerId);
  // Whole days in Türkiye's time; `to` is exclusive in the API and the field is an inclusive day.
  if (from) query.set('from', `${from}T00:00:00+03:00`);
  if (to) query.set('to', `${nextDay(to)}T00:00:00+03:00`);
  if (response) query.set('response', response);
  if (overdue) query.set('overdue', overdue);
  if (risk) query.set('risk', risk);
  const list = await apiFetch<ServiceIncidentListResponse>(`/admin/service-incidents?${query.toString()}`);

  const filterParams: QueryParams = {
    status: state === 'open' ? '' : state,
    reason,
    providerId,
    from,
    to,
    response,
    overdue,
    risk,
  };
  const hasFilters = Boolean(reason || providerId || from || to || response || overdue || risk);

  const views: TabItem[] = [
    { key: 'open', label: 'Açık', testId: 'incident-view-open' },
    { key: 'decided', label: 'Karar verilmiş', testId: 'incident-view-decided' },
    { key: 'all', label: 'Tümü', testId: 'incident-view-all' },
  ].map((view) => (view.key === state ? { ...view, count: list.total } : view));

  const summary =
    list.total === 0
      ? state === 'open'
        ? 'Karar bekleyen bildirim yok'
        : 'Bu görünümde bildirim yok'
      : state === 'open'
        ? `${formatCount(list.total)} bildirim karar bekliyor · en eski başta`
        : `${formatCount(list.total)} bildirim`;

  return (
    <main className="finance-list-page">
      <PageHeader title="Hizmet aksaklıkları" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Bildirim görünümleri"
        items={views}
        active={STATES.slice(0, 3).includes(state) ? state : ''}
        path={PATH}
        params={filterParams}
        param="status"
        defaultKey="open"
        testId="incident-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? buildHref(PATH, { status: filterParams.status }) : null}
        preserve={{ providerId }}
        label="Hizmet aksaklığı filtreleri"
        testId="incident-filters"
      >
        <FilterField label="Durum" htmlFor="incident-status">
          <select id="incident-status" name="status" defaultValue={state === 'open' ? '' : state}>
            <option value="">Açık (karar bekleyen)</option>
            <option value="decided">Karar verilmiş</option>
            <option value="all">Tümü</option>
            {PROVIDER_INCIDENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_INCIDENT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Neden" htmlFor="incident-reason">
          <select id="incident-reason" name="reason" defaultValue={reason}>
            <option value="">Tümü</option>
            {SERVICE_ISSUE_REASONS.map((value) => (
              <option key={value} value={value}>
                {SERVICE_ISSUE_REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Yanıt" htmlFor="incident-response">
          <select id="incident-response" name="response" defaultValue={response}>
            <option value="">Tümü</option>
            <option value="responded">Yanıtladı</option>
            <option value="not_responded">Yanıtlamadı</option>
          </select>
        </FilterField>
        <FilterField label="Yanıt süresi" htmlFor="incident-overdue">
          <select id="incident-overdue" name="overdue" defaultValue={overdue}>
            <option value="">Tümü</option>
            <option value="true">72 saat geçti, yanıt yok</option>
          </select>
        </FilterField>
        <FilterField label="Hizmet veren riski" htmlFor="incident-risk">
          <select id="incident-risk" name="risk" defaultValue={risk}>
            <option value="">Tümü</option>
            {RELIABILITY_LEVELS.map((value) => (
              <option key={value} value={value}>
                {RELIABILITY_LEVEL_LABELS[value]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Başlangıç" htmlFor="incident-from">
          <input id="incident-from" name="from" type="date" defaultValue={from} />
        </FilterField>
        <FilterField label="Bitiş" htmlFor="incident-to">
          <input id="incident-to" name="to" type="date" defaultValue={to} />
        </FilterField>
      </FilterBar>

      {providerId ? (
        <p className="detail-muted-note" data-testid="incident-provider-pin">
          Yalnız bir hizmet verenin bildirimleri gösteriliyor.{' '}
          <Link className="cell-link" href={buildHref(PATH, filterParams, { providerId: undefined })}>
            Tüm hizmet verenler
          </Link>
        </p>
      ) : null}

      <div className="data-list-card">
        <span className="sr-only" data-testid="incident-count" data-total={list.total}>
          {list.total} bildirim
        </span>
        {list.items.length === 0 ? (
          <EmptyState
            title={state === 'open' && !hasFilters ? 'Karar bekleyen bildirim yok' : 'Bu görünümde bildirim yok'}
            description="Bir müşteri eşleştiği hizmet veren için hizmet aksaklığı bildirdiğinde burada görünür."
            action={
              hasFilters || state !== 'open' ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Açık bildirimler
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Hizmet aksaklıkları" columns={COLUMNS} minWidth={1180} testId="incident-table">
            {list.items.map((item) => (
              <IncidentRow key={item.id} item={item} canOpenRequest={canOpenRequest} canOpenProvider={canOpenProvider} />
            ))}
          </DataTable>
        )}
        {list.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            hasNextPage={list.hasNextPage}
            noun="bildirim"
            summaryTestId="incident-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}

function IncidentRow({
  item,
  canOpenRequest,
  canOpenProvider,
}: {
  item: ServiceIncidentListItem;
  canOpenRequest: boolean;
  canOpenProvider: boolean;
}) {
  const requestRef = item.request.requestNumber ?? `#${item.request.id.slice(-8)}`;
  return (
    <tr data-testid="service-incident-row" data-incident-id={item.id} data-status={item.status}>
      <td>
        <Link className="cell-link" href={`/service-incidents/${item.id}`}>
          <code className="cell-break">{item.incidentNumber}</code>
        </Link>
        <div className="cell-muted">{item.roundNumber}. tur</div>
      </td>
      <td className="cell-nowrap">{formatDateTime(item.reportedAt)}</td>
      <td>
        <div className="cell-stack">
          {canOpenProvider ? (
            <Link className="cell-link cell-break" href={`/providers/${item.provider.id}`}>
              {item.provider.businessName}
            </Link>
          ) : (
            <span className="cell-break">{item.provider.businessName}</span>
          )}
          <span className={reliabilityLevelBadgeClass(item.provider.riskLevel)}>
            {RELIABILITY_LEVEL_LABELS[item.provider.riskLevel]} · {item.provider.confirmed90d}
          </span>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          {canOpenRequest ? (
            <Link className="cell-link" href={`/requests/${item.request.id}`}>
              {requestRef}
            </Link>
          ) : (
            <span>{requestRef}</span>
          )}
          <span className="cell-muted cell-break">{item.request.categoryName}</span>
        </div>
      </td>
      <td>{item.reasonLabel || SERVICE_ISSUE_REASON_LABELS[item.reason]}</td>
      <td>
        <span className={incidentStatusBadgeClass(item.status)} data-testid="service-incident-status">
          {PROVIDER_INCIDENT_STATUS_LABELS[item.status as ProviderIncidentStatus] ?? item.status}
        </span>
      </td>
      <td>
        <div className="cell-stack">
          {item.respondedAt ? (
            <span className="cell-nowrap">Yanıtladı · {formatDateTime(item.respondedAt)}</span>
          ) : (
            <span className="cell-muted">Yanıt yok</span>
          )}
          {item.responseOverdue ? (
            <span className="badge badge-bad" data-testid="incident-response-overdue">
              Süre geçti
            </span>
          ) : null}
          {item.lateResponse ? (
            <span className="badge badge-warn" data-testid="incident-response-late">
              Geç yanıt
            </span>
          ) : null}
        </div>
      </td>
      <td>
        {item.decision ? (
          <div className="cell-stack">
            <span>{INCIDENT_DECISION_LABELS[item.decision.decision]}</span>
            {item.decision.corrected ? <span className="badge badge-info">Düzeltildi</span> : null}
            <span className="cell-muted cell-nowrap">{formatDateTime(item.decision.decidedAt)}</span>
          </div>
        ) : (
          <span className="cell-muted">Karar bekliyor</span>
        )}
      </td>
    </tr>
  );
}

/** `YYYY-MM-DD` + 1 day, so an inclusive "to" day becomes the API's exclusive bound. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

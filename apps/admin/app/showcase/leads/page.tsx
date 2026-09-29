import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  showcaseLeadBadgeClass,
  SHOWCASE_LEAD_STATUS_LABELS,
  SHOWCASE_LEAD_URGENCY_LABELS,
  type ShowcaseAdminLead,
  type ShowcaseLeadStatus,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import { parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';

const STATUSES: ShowcaseLeadStatus[] = [
  'OPEN',
  'ANSWERED',
  'BREACHED',
  'RELEASED',
  'CLOSED_UNANSWERED',
];

const PATH = '/showcase/leads';

/** Rows per page; the API caps a page at 100. */
const PAGE_SIZE = 50;

type LeadsPage = {
  leads: ShowcaseAdminLead[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  statusCounts: Record<ShowcaseLeadStatus, number>;
};

type LeadsPageProps = {
  searchParams: Promise<{ status?: string; providerId?: string; page?: string }>;
};

/**
 * Vitrinden gelen talepler (#20), design `list:leads` (paket 2
 * `33-vitrinden-gelen-talepler`, ADMIN-DESIGN-001 Faz 3C).
 *
 * Direct vitrin leads, for the operator.
 *
 * ## Read-only, and the two absences are the point
 *
 * There is no action that closes a lead from here: an operator's power over one
 * is exercised through the request it belongs to, and refusing that request
 * closes the lead in the same transaction. A button that closed a lead while
 * leaving its request open would produce a state nobody could explain.
 *
 * There is also no action that releases one. Releasing a request to the market
 * is the customer's decision and only theirs — the database refuses a release
 * that is not accompanied by it — and an operator route bypassing that would
 * make the constraint decorative.
 *
 * ## What this list is actually for
 *
 * Two things. Finding a lead when somebody complains about one, and watching the
 * breach rate: `BREACHED` is a countable fact this phase produces on purpose,
 * and what it should eventually cost a provider is a separate product decision
 * that this data is meant to inform.
 *
 * No customer telephone number or e-mail address appears here, exactly as none
 * appears on the provider's own inbox.
 *
 * ## Against the design
 *
 * The list is paged on the server (API-HARDENING-001): every lead is reachable,
 * the footer's total is the filtered list's real size, and the saved views carry
 * exact counters from the same answer. The design's "Bu ay 38 talep" is still
 * not drawn — a month's count is not something this answer gives — and neither
 * are its Ara and Tarih filters (the API takes neither). "Süresi aşılanları
 * göster" is the "Süre doldu" view.
 */

/** The design's ⓘ; every sentence of it holds (showcase-lead*.service.ts). */
const SCREEN_INFO =
  'Müşteri bir vitrin kartından doğrudan o işletmeye talep gönderdiğinde oluşur. Bu talep moderasyondan geçmez, başka hizmet verene gösterilmez ve işletme kartında yazan sürede dönmeyi taahhüt eder. Süre aşılırsa müşteri talebini genel pazara açabilir; bu kararı yalnız müşteri verir, buradan açılamaz ya da kapatılamaz. Bir talebi durdurmak gerekirse talebin kendi ekranından reddedin; vitrin talebi de onunla kapanır. Müşterinin telefonu ve e-postası bu listede gösterilmez.';

const COLUMNS: DataColumn[] = [
  { key: 'request', label: 'Talep' },
  { key: 'provider', label: 'İşletme' },
  { key: 'card', label: 'Kart' },
  { key: 'urgency', label: 'Aciliyet' },
  { key: 'due', label: 'Dönüş süresi' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function ShowcaseLeadsPage({ searchParams }: LeadsPageProps) {
  const { can } = await requireAdmin('SHOWCASE_LEADS_READ');
  const canOpenRequest = can('REQUESTS_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');

  const { status, providerId, page: pageParam } = await searchParams;
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;
  const provider = (providerId ?? '').trim();
  const page = parsePage(pageParam);

  const query = new URLSearchParams();
  if (selected) query.set('status', selected);
  if (provider) query.set('providerId', provider);
  query.set('page', String(page));
  query.set('pageSize', String(PAGE_SIZE));

  const response = await apiFetch<LeadsPage>(`/admin/showcase/leads?${query.toString()}`);
  const { leads, statusCounts } = response;
  const scopeTotal = STATUSES.reduce((sum, value) => sum + (statusCounts[value] ?? 0), 0);

  const params: QueryParams = { status: selected ?? '', providerId: provider };
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: scopeTotal, testId: 'lead-view-all' },
    ...STATUSES.map((value) => ({
      key: value,
      label: SHOWCASE_LEAD_STATUS_LABELS[value],
      count: statusCounts[value] ?? 0,
      testId: `lead-view-${value.toLowerCase()}`,
    })),
  ];

  // The total is the API's count for this view, never the rows on this page.
  const summary =
    response.total === 0
      ? 'Bu görünümde vitrin talebi yok'
      : `${formatCount(response.total)} talep · en yeni başta · moderasyonsuz, yalnız kart sahibine`;

  return (
    <main className="showcase-leads-page">
      <PageHeader title="Vitrinden gelen talepler" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Vitrin talebi durumu"
        items={views}
        active={selected ?? ''}
        path={PATH}
        params={params}
        param="status"
        testId="lead-views"
      />

      {provider ? (
        <p className="detail-muted-note" data-testid="lead-provider-filter">
          Yalnız bir işletmenin vitrin talepleri gösteriliyor.{' '}
          <Link href={selected ? `${PATH}?status=${selected}` : PATH}>Tüm işletmeler</Link>
        </p>
      ) : null}

      <div className="data-list-card">
        {leads.length === 0 ? (
          <EmptyState
            title="Talep yok"
            description={
              selected
                ? 'Bu durumda bir vitrin talebi bulunmuyor.'
                : 'Bir müşteri vitrin kartından doğrudan talep gönderdiğinde burada listelenir.'
            }
          />
        ) : (
          <DataTable caption="Vitrinden gelen talepler" columns={COLUMNS} minWidth={1080} testId="lead-table">
            {leads.map((lead) => {
              const requestRef = lead.request.requestNumber ?? lead.request.id.slice(-6);
              return (
                <tr key={lead.id} data-testid="lead-row" data-status={lead.status}>
                  <td>
                    <div className="cell-stack">
                      {canOpenRequest ? (
                        <Link className="cell-link" href={`/requests/${lead.request.id}`}>
                          <strong className="display-number">{requestRef}</strong>
                        </Link>
                      ) : (
                        <strong className="display-number">{requestRef}</strong>
                      )}
                      <span className="cell-muted">
                        {lead.request.category.name} · {lead.request.district}, {lead.request.city}
                      </span>
                      <span className="cell-muted">
                        Kalite {lead.request.qualityScore} · {formatDateTime(lead.request.submittedAt)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      {canOpenProvider ? (
                        <Link className="cell-link" href={`/providers/${lead.provider.id}`}>
                          {lead.provider.businessName}
                        </Link>
                      ) : (
                        <span>{lead.provider.businessName}</span>
                      )}
                      {/*
                        Whether the request is still reserved. It is the one
                        field that says at a glance if a released lead really did
                        reach the market, and it is read straight off the gate
                        column rather than inferred from the status.
                      */}
                      <span className="cell-muted">
                        {lead.request.directShowcaseProviderId ? 'Yalnız bu işletmeye açık' : 'Genel pazara açık'}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-break">{lead.cardVersion.title}</span>
                      <span className="cell-muted">{lead.cardVersion.versionNumber}. sürüm</span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span>{SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]}</span>
                      <span className="cell-muted">{lead.slaHoursSnapshot} saat taahhüt</span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span>{formatDateTime(lead.slaDueAt)}</span>
                      {lead.breachedAt ? (
                        <span className="cell-muted">Aşıldı: {formatDateTime(lead.breachedAt)}</span>
                      ) : lead.respondedAt ? (
                        <span className="cell-muted">Dönüş: {formatDateTime(lead.respondedAt)}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className={showcaseLeadBadgeClass(lead.status)}>
                        {SHOWCASE_LEAD_STATUS_LABELS[lead.status]}
                      </span>
                      {lead.fallbackDecision ? (
                        <span className="cell-muted">
                          Müşteri kararı: {lead.fallbackDecision === 'RELEASE' ? 'Pazara aç' : 'Kapalı tut'}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="col-actions">
                    {/* The design's "Aç" is the request, where the operator acts on a lead. */}
                    {canOpenRequest ? (
                      <Link className="btn btn-secondary btn-sm" href={`/requests/${lead.request.id}`}>
                        Aç
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={params}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="talep"
            summaryTestId="lead-count"
          />
        ) : null}
      </div>
    </main>
  );
}

import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  SUPPORT_TICKET_REQUESTER_ROLES,
  SUPPORT_TICKET_STATUSES,
  supportTicketRequesterRoleBadgeClass,
  supportTicketRequesterRoleLabel,
  supportTicketStatusBadgeClass,
  supportTicketStatusLabel,
  type SupportTicketListEntry,
  type SupportTicketListResponse,
} from '../../lib/api';
import {
  OPEN_SUPPORT_TICKETS_FILTER,
  OPEN_SUPPORT_TICKET_STATUSES,
  isOpenSupportTicketFilter,
  parseRequesterRoleFilter,
  parseStatusFilter,
  statusFilterValue,
} from '../../lib/support-ticket-filter';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { buildHref, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';

/**
 * The support queue — one queue, both sides of the marketplace.
 *
 * The screen answers one question — who has asked for help, what state is each
 * ask in, and which one moved most recently — and hands the operator to the
 * ticket itself to do anything about it. Everything it offers is a read: no
 * ticket is created, deleted or reassigned from here, and none can be, because
 * the API has no route for any of the three.
 *
 * Hizmet alan and hizmet veren tickets share this list rather than getting one
 * each, so nothing can fall between two queues while each is waiting for
 * somebody who is watching the other. Which desk a ticket is on is a badge on
 * its row and a filter in the toolbar, both driven by the ticket's own
 * `requesterRole` snapshot.
 *
 * The status filter takes a set, not a single status. `?status=OPEN` still
 * means what it always did — it is a one-element set — and `?status=OPEN,IN_PROGRESS`
 * is the backlog: everything still waiting on somebody. That second form is
 * where the dashboard's "Açık destek talepleri" card points, and it is offered
 * as the first option in the select below, so the number on the card and the
 * rows on this screen are the same set of tickets rather than two lists that
 * happen to overlap.
 *
 * ADMIN-DESIGN-001 Faz 3B (paket 2 `24-destek-talepleri`): the design's list
 * template — saved views with the API's own per-status counts, the shared
 * filter bar, the shared table (which scrolls inside its own box on a phone)
 * and the shared page footer. Not rendered: the design's Ara and Tarih filters
 * (the API takes neither), its "Kategori" column and "Bekleme süresi" (the list
 * answer carries no topic and no who-spoke-last), and "Kapanmış talepleri
 * göster" as a button — the "Kapatıldı" view is that list.
 */

const PATH = '/support';

/** The design's ⓘ, fitted to what this queue is and is not. */
const SCREEN_INFO =
  'Hizmet alanların ve hizmet verenlerin panellerinden açtığı destek talepleri, tek kuyrukta. Yanıt yazmak, durumu değiştirmek ya da bir paket iadesi isteği açmak için talebi açın. Buradan talep oluşturulamaz, silinemez ve başkasına devredilemez.';

const COLUMNS: DataColumn[] = [
  { key: 'subject', label: 'Konu' },
  { key: 'requester', label: 'Gönderen' },
  { key: 'role', label: 'Talep sahibi' },
  { key: 'created', label: 'Geldiği zaman' },
  { key: 'activity', label: 'Son hareket' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const DEFAULT_PAGE_SIZE = 25;

type RawSearchParams = {
  /** An array when the caller repeated `?status=` — Next hands both shapes over. */
  status?: string | string[];
  /** Likewise for the desk, though repeating it is not a way to ask for both. */
  requesterRole?: string | string[];
  page?: string;
};

type AdminSupportPageProps = {
  searchParams: Promise<RawSearchParams>;
};

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export default async function AdminSupportPage({ searchParams }: AdminSupportPageProps) {
  await requireAdmin('SUPPORT_READ');

  const params = await searchParams;
  const statuses = parseStatusFilter(params.status);
  const requesterRole = parseRequesterRoleFilter(params.requesterRole);
  // Canonical order: `?status=IN_PROGRESS,OPEN` is the same filter as
  // `?status=OPEN,IN_PROGRESS`, and the select and the saved view below should
  // show it as chosen either way rather than silently reading "Tümü".
  const selectedFilter = isOpenSupportTicketFilter(statuses)
    ? OPEN_SUPPORT_TICKETS_FILTER
    : statusFilterValue(statuses);
  const page = normalizePage(params.page);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(DEFAULT_PAGE_SIZE));
  if (selectedFilter) apiQuery.set('status', selectedFilter);
  if (requesterRole) apiQuery.set('requesterRole', requesterRole);

  const response = await apiFetch<SupportTicketListResponse>(
    `/admin/support/tickets?${apiQuery.toString()}`,
  );

  // The backlog's own count, so the view below says the same number the
  // dashboard card does. The API scopes these counts to the chosen desk.
  const openTicketCount = OPEN_SUPPORT_TICKET_STATUSES.reduce(
    (total, status) => total + (response.statusCounts[status] ?? 0),
    0,
  );
  const allTicketCount = SUPPORT_TICKET_STATUSES.reduce(
    (total, status) => total + (response.statusCounts[status] ?? 0),
    0,
  );
  const hasFilters = statuses.length > 0 || requesterRole !== null;

  const filterParams: QueryParams = {
    status: selectedFilter,
    requesterRole: requesterRole ?? '',
  };

  // Exact counts from the API (`statusCounts`, within the chosen desk). A
  // status set that is not one of these views still filters the list; it is
  // simply not one of the tabs.
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: allTicketCount, testId: 'support-view-all' },
    { key: OPEN_SUPPORT_TICKETS_FILTER, label: 'Açık + İşlemde', count: openTicketCount, testId: 'support-view-backlog' },
    ...SUPPORT_TICKET_STATUSES.map((value) => ({
      key: value,
      label: supportTicketStatusLabel(value),
      count: response.statusCounts[value] ?? 0,
      testId: `support-view-${value.toLowerCase()}`,
    })),
  ];

  const summary =
    allTicketCount === 0 && !requesterRole
      ? 'Henüz destek talebi açılmadı'
      : openTicketCount === 0
        ? 'Cevap bekleyen talep yok'
        : `${formatCount(openTicketCount)} talep açık veya işlemde · son hareketi en yeni olan önce`;

  return (
    <main className="support-page">
      <PageHeader title="Destek talepleri" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Destek görünümleri"
        items={views}
        active={selectedFilter}
        path={PATH}
        params={filterParams}
        param="status"
        testId="support-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Destek filtreleri"
        testId="support-filters"
      >
        {/*
          The desk filter comes first because it splits the queue in two, where
          the status filter narrows whichever half is on screen — and because
          reading them left to right then says what the list is: "hizmet
          verenlerin açık talepleri".
        */}
        <FilterField label="Talep sahibi" htmlFor="support-requester-role">
          <select
            id="support-requester-role"
            name="requesterRole"
            defaultValue={requesterRole ?? ''}
            data-testid="support-requester-role-filter"
          >
            <option value="">Tümü</option>
            {SUPPORT_TICKET_REQUESTER_ROLES.map((value) => (
              <option key={value} value={value}>
                {`${supportTicketRequesterRoleLabel(value)} (${response.requesterRoleCounts[value] ?? 0})`}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Durum" htmlFor="support-status">
          <select id="support-status" name="status" defaultValue={selectedFilter}>
            <option value="">Tümü</option>
            {/*
              The backlog, as one option. It is where the dashboard card points,
              so an operator who arrives from there finds the filter reflecting
              the link they followed rather than silently reading "Tümü" and
              resetting the moment they press Filtrele.
            */}
            <option value={OPEN_SUPPORT_TICKETS_FILTER}>{`Açık + İşlemde (${openTicketCount})`}</option>
            {SUPPORT_TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {`${supportTicketStatusLabel(value)} (${response.statusCounts[value] ?? 0})`}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        <span
          className="sr-only"
          data-testid="support-ticket-count"
          data-total={response.total}
        >
          {response.total} talep
        </span>
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? isOpenSupportTicketFilter(statuses) && !requesterRole
                  ? 'Bekleyen destek talebi yok.'
                  : 'Bu filtreyle destek talebi bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada destek talebi yok.'
                  : 'Henüz destek talebi açılmadı.'
            }
            description={
              hasFilters
                ? 'Filtreleri temizleyerek tüm talepleri görebilirsiniz.'
                : 'Bir hizmet alan veya hizmet veren panelinden destek talebi açtığında burada görünür.'
            }
            action={
              hasFilters || response.total > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  {hasFilters ? 'Filtreyi temizle' : 'İlk sayfaya dön'}
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Destek talepleri" columns={COLUMNS} minWidth={900} testId="support-ticket-table">
            {response.items.map((ticket) => (
              <SupportTicketRow key={ticket.id} ticket={ticket} />
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
            noun="talep"
            summaryTestId="support-page-summary"
          />
        ) : null}
      </div>
    </main>
  );
}

function SupportTicketRow({ ticket }: { ticket: SupportTicketListEntry }) {
  return (
    <tr
      data-testid="support-ticket-row"
      data-status={ticket.status}
      data-requester-role={ticket.requesterRole}
    >
      <td>
        <div className="cell-stack">
          <strong className="cell-break" data-testid="support-ticket-subject">
            {ticket.subject}
          </strong>
          <span className="cell-muted">
            <code>#{ticket.id.slice(-8)}</code>
          </span>
        </div>
      </td>
      <td>
        {/*
          The name where there is one, the address otherwise. An account created
          for a guest request has no name until somebody fills one in, and
          printing an invented placeholder would make the two cases
          indistinguishable.
        */}
        <div className="cell-stack">
          <span>{ticket.requester.name ?? <span className="cell-muted">İsimsiz hesap</span>}</span>
          {ticket.requester.email ? <span className="cell-muted cell-break">{ticket.requester.email}</span> : null}
        </div>
      </td>
      {/*
        Which desk, in its own column and as a badge rather than as a word
        tucked under the name. The queue is scanned rather than read, and the
        rules an operator is about to apply depend on this first.
      */}
      <td>
        <span
          className={supportTicketRequesterRoleBadgeClass(ticket.requesterRole)}
          data-testid="support-ticket-requester-role"
        >
          {supportTicketRequesterRoleLabel(ticket.requesterRole)}
        </span>
      </td>
      <td>{formatDateTime(ticket.createdAt)}</td>
      <td>{formatDateTime(ticket.lastActivityAt)}</td>
      <td>
        <span className={supportTicketStatusBadgeClass(ticket.status)}>
          {supportTicketStatusLabel(ticket.status)}
        </span>
      </td>
      <td className="col-actions">
        <Link className="btn btn-secondary btn-sm" href={`/support/${ticket.id}`} aria-label={`Aç: ${ticket.subject}`}>
          Aç
        </Link>
      </td>
    </tr>
  );
}

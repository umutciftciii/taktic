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
  type SupportTicketStatus,
} from '../../lib/api';
import {
  OPEN_SUPPORT_TICKETS_FILTER,
  OPEN_SUPPORT_TICKET_STATUSES,
  buildSupportListHref,
  isOpenSupportTicketFilter,
  parseRequesterRoleFilter,
  parseStatusFilter,
  statusFilterValue,
} from '../../lib/support-ticket-filter';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

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
 * The table below carries `support-table-scroll` as well as `table-scroll`.
 * `.table-scroll` only gets its `overflow-x` inside a `.table-card`, and this
 * table lives in a `.section-card` — so without the extra class the six columns
 * widen the document itself on a 320px phone instead of scrolling inside their
 * own box.
 */

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
  await requireAdmin();

  const params = await searchParams;
  const statuses = parseStatusFilter(params.status);
  const requesterRole = parseRequesterRoleFilter(params.requesterRole);
  // Canonical order for the select: `?status=IN_PROGRESS,OPEN` is the same
  // filter as `?status=OPEN,IN_PROGRESS`, and the option below should be the
  // one shown as chosen either way rather than the box silently reading "Tümü".
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

  // The backlog's own count, so the option below says the same number the
  // dashboard card does.
  const openTicketCount = OPEN_SUPPORT_TICKET_STATUSES.reduce(
    (total, status) => total + (response.statusCounts[status] ?? 0),
    0,
  );

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main>
      <PageHeader
        title="Destek Talepleri"
        subtitle="Hizmet alanların ve hizmet verenlerin açtığı destek talepleri, tek kuyrukta. Yanıtlamak ve durumunu değiştirmek için bir talebi açın."
      />

      <form className="admin-toolbar" method="get" action="/support">
        {/*
          The desk filter comes first because it splits the queue in two, where
          the status filter narrows whichever half is on screen — and because
          reading them left to right then says what the list is: "hizmet
          verenlerin açık talepleri".
        */}
        <div className="admin-toolbar-field">
          <label htmlFor="support-requester-role">Talep sahibi</label>
          <select
            id="support-requester-role"
            name="requesterRole"
            defaultValue={requesterRole ?? ''}
            data-testid="support-requester-role-filter"
          >
            <option value="">Tümü</option>
            {SUPPORT_TICKET_REQUESTER_ROLES.map((value) => (
              <option key={value} value={value}>
                {`${supportTicketRequesterRoleLabel(value)} (${
                  response.requesterRoleCounts[value] ?? 0
                })`}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="support-status">Durum</label>
          <select id="support-status" name="status" defaultValue={selectedFilter}>
            <option value="">Tümü</option>
            {/*
              The backlog, as one option. It is where the dashboard card points,
              so an operator who arrives from there finds the filter reflecting
              the link they followed rather than silently reading "Tümü" and
              resetting the moment they press Uygula.
            */}
            <option value={OPEN_SUPPORT_TICKETS_FILTER}>
              {`Açık + İşlemde (${openTicketCount})`}
            </option>
            {SUPPORT_TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {`${supportTicketStatusLabel(value)} (${response.statusCounts[value] ?? 0})`}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span
            className="admin-toolbar-summary"
            data-testid="support-ticket-count"
            data-total={response.total}
          >
            {response.total === 0
              ? '0 talep'
              : `${startIndex}-${endIndex} / ${response.total} talep`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {statuses.length || requesterRole ? (
            <Link className="btn btn-ghost btn-sm" href="/support">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Talepler"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} talep/sayfa · son hareket önce`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title={
              statuses.length || requesterRole
                ? isOpenSupportTicketFilter(statuses) && !requesterRole
                  ? 'Bekleyen destek talebi yok.'
                  : 'Bu filtreyle destek talebi bulunamadı.'
                : 'Henüz destek talebi açılmadı.'
            }
            description={
              statuses.length || requesterRole
                ? 'Filtreleri temizleyerek tüm talepleri görebilirsiniz.'
                : 'Bir hizmet alan veya hizmet veren panelinden destek talebi açtığında burada görünür.'
            }
            action={
              statuses.length || requesterRole ? (
                <Link className="btn btn-secondary btn-sm" href="/support">
                  Filtreyi temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="table-scroll support-table-scroll">
            <table className="data-table" data-testid="support-ticket-table">
              <thead>
                <tr>
                  <th>Durum</th>
                  <th>Talep sahibi</th>
                  <th>Konu</th>
                  <th>Kim</th>
                  <th>Son hareket</th>
                  <th>Oluşturulma</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {response.items.map((ticket) => (
                  <SupportTicketRow key={ticket.id} ticket={ticket} />
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
              href={buildSupportListHref(statuses, response.page - 1, requesterRole)}
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
              href={buildSupportListHref(statuses, response.page + 1, requesterRole)}
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

function SupportTicketRow({ ticket }: { ticket: SupportTicketListEntry }) {
  return (
    <tr
      data-testid="support-ticket-row"
      data-status={ticket.status}
      data-requester-role={ticket.requesterRole}
    >
      <td>
        <span className={supportTicketStatusBadgeClass(ticket.status)}>
          {supportTicketStatusLabel(ticket.status)}
        </span>
      </td>
      {/*
        Which desk, in its own column and as a badge rather than as a word
        tucked under the name. The queue is scanned rather than read, and the
        rules an operator is about to apply — what the ticket can be about, what
        the answer may say — depend on this before they depend on anything else
        in the row.
      */}
      <td>
        <span
          className={supportTicketRequesterRoleBadgeClass(ticket.requesterRole)}
          data-testid="support-ticket-requester-role"
        >
          {supportTicketRequesterRoleLabel(ticket.requesterRole)}
        </span>
      </td>
      <td data-testid="support-ticket-subject">{ticket.subject}</td>
      <td>
        {/*
          The name where there is one, the address otherwise. An account created
          for a guest request has no name until somebody fills one in, and
          printing an invented placeholder would make the two cases
          indistinguishable.
        */}
        <div>{ticket.requester.name ?? <span className="cell-muted">İsimsiz hesap</span>}</div>
        {ticket.requester.email ? (
          <div className="cell-muted" style={{ fontSize: 12 }}>
            {ticket.requester.email}
          </div>
        ) : null}
      </td>
      <td>{formatDateTime(ticket.lastActivityAt)}</td>
      <td>{formatDateTime(ticket.createdAt)}</td>
      <td>
        <div className="inline-actions">
          <Link className="btn btn-ghost btn-sm" href={`/support/${ticket.id}`}>
            Detay
          </Link>
        </div>
      </td>
    </tr>
  );
}

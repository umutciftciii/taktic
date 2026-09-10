import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  getCurrentUser,
  SHOWCASE_LEAD_STATUS_LABELS,
  SHOWCASE_LEAD_URGENCY_LABELS,
  type ProviderProfile,
  type ShowcaseProviderLead,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { leadDeadlineLabel, showcaseLeadBadgeClass } from '../showcase-lead-ui';

type LeadInboxPageProps = { params: Promise<{ id: string }> };

/**
 * The direct leads a business's vitrin cards produced.
 *
 * ## Why this is a page of its own rather than a filter on "Uygun talepler"
 *
 * The two lists read different rows. A direct lead sits at `SUBMITTED` until
 * the business it was addressed to answers it, and the discovery list is
 * `APPROVED` by definition — so a lead would be invisible there right up until
 * it was answered, which is exactly backwards.
 *
 * ## What the list is ordered by, and why
 *
 * The deadline, soonest first. Every other list in this panel is ordered by
 * what is most interesting; this one is ordered by what is most urgent, because
 * each row carries a promise with a clock on it and the row about to be broken
 * is the one that has to be at the top.
 */
export default async function ShowcaseLeadInboxPage({ params }: LeadInboxPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/vitrin/talepler`);
  }

  const [provider, inbox, creditBalance] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderProfile>(`/providers/${id}`)),
    fetchOrNotFound(() =>
      apiFetch<{ leads: ShowcaseProviderLead[] }>(`/providers/${id}/showcase/leads`),
    ),
    readCreditBalance(id),
  ]);

  const waiting = inbox.leads.filter((lead) => lead.status === 'OPEN').length;

  return (
    <ProviderShell
      user={user}
      providerId={id}
      businessName={provider.businessName}
      active="showcase-leads"
      creditBalance={creditBalance}
      status={provider.status}
      counts={{ showcaseLeads: waiting }}
    >
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Vitrin talepleri</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Vitrin</span>
        <h1 className="pdash-page-title">Vitrin talepleri</h1>
        <p className="pdash-page-sub">
          Bu talepler doğrudan vitrin kartlarınızdan geldi ve yalnız size iletildi. Teklif
          vermek için kredi harcanmaz — yerleşim bedelini zaten ödediniz.
        </p>
      </header>

      {inbox.leads.length === 0 ? (
        <div className="pdash-detail-card">
          <p className="muted">
            Henüz vitrin talebiniz yok. Yayında bir kartınız varsa, bölgenizdeki müşteriler
            karttan doğrudan talep gönderebilir.
          </p>
        </div>
      ) : (
        /*
          The scroll belongs to the box, not the document: five columns must not
          widen the page itself on a 320px phone. Same pattern as the card list.
        */
        <div className="pdash-table-card">
          <div className="pdash-table-scroll">
            <table className="pdash-table">
              <thead>
                <tr>
                  <th>Talep</th>
                  <th>Kart</th>
                  <th>Aciliyet</th>
                  <th>Son yanıt</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {inbox.leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link href={`/providers/${id}/vitrin/talepler/${lead.id}`}>
                        {lead.request.requestNumber ?? 'Talep'}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lead.request.category.name} · {lead.request.district},{' '}
                        {lead.request.city}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {formatDateTime(lead.createdAt)}
                      </div>
                    </td>
                    <td>{lead.card.title}</td>
                    <td>
                      {SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lead.slaHours} saat taahhüt
                      </div>
                    </td>
                    <td>{leadDeadlineLabel(lead)}</td>
                    <td>
                      <span className={showcaseLeadBadgeClass(lead.status)}>
                        {SHOWCASE_LEAD_STATUS_LABELS[lead.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ProviderShell>
  );
}

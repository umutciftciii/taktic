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
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const STATUSES: ShowcaseLeadStatus[] = [
  'OPEN',
  'ANSWERED',
  'BREACHED',
  'RELEASED',
  'CLOSED_UNANSWERED',
];

type LeadsPageProps = {
  searchParams: Promise<{ status?: string; providerId?: string }>;
};

/**
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
 */
export default async function ShowcaseLeadsPage({ searchParams }: LeadsPageProps) {
  await requireAdmin();

  const { status, providerId } = await searchParams;
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;

  const query = new URLSearchParams();
  if (selected) query.set('status', selected);
  if (providerId) query.set('providerId', providerId);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const { leads } = await apiFetch<{ leads: ShowcaseAdminLead[] }>(
    `/admin/showcase/leads${suffix}`,
  );

  return (
    <>
      <PageHeader
        title="Vitrin Talepleri"
        subtitle="Vitrin kartlarından doğrudan gelen talepler, yanıt süreleri ve müşteri kararları."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vitrin Talepleri' }]}
      />

      <SectionCard
        title="Talepler"
        subtitle={`${leads.length} talep listeleniyor. Bu talepler moderasyondan geçmeden doğrudan kart sahibine iletilir; reddedilen bir talep, talebin kendi ekranından kapatılır.`}
        actions={
          <span className="inline-actions">
            <Link
              className={`btn btn-sm ${selected ? 'btn-secondary' : 'btn-primary'}`}
              href="/showcase/leads"
            >
              Tümü
            </Link>
            {STATUSES.map((candidate) => (
              <Link
                key={candidate}
                className={`btn btn-sm ${selected === candidate ? 'btn-primary' : 'btn-secondary'}`}
                href={`/showcase/leads?status=${candidate}`}
              >
                {SHOWCASE_LEAD_STATUS_LABELS[candidate]}
              </Link>
            ))}
          </span>
        }
        padded={false}
      >
        {leads.length === 0 ? (
          <EmptyState
            title="Talep yok"
            description="Bu filtreye uyan bir vitrin talebi bulunmuyor."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Talep</th>
                  <th>İşletme</th>
                  <th>Kart</th>
                  <th>Aciliyet</th>
                  <th>Son yanıt</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link href={`/requests/${lead.request.id}`}>
                        {lead.request.requestNumber ?? lead.request.id.slice(-6)}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lead.request.category.name} · {lead.request.district},{' '}
                        {lead.request.city}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Kalite {lead.request.qualityScore} ·{' '}
                        {formatDateTime(lead.request.submittedAt)}
                      </div>
                    </td>
                    <td>
                      <Link href={`/providers/${lead.provider.id}`}>
                        {lead.provider.businessName}
                      </Link>
                      {/*
                        Whether the request is still reserved. It is the one
                        field that says at a glance if a released lead really did
                        reach the market, and it is read straight off the gate
                        column rather than inferred from the status.
                      */}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lead.request.directShowcaseProviderId
                          ? 'Yalnız bu işletmeye açık'
                          : 'Genel pazara açık'}
                      </div>
                    </td>
                    <td>{lead.cardVersion.title}</td>
                    <td>
                      {SHOWCASE_LEAD_URGENCY_LABELS[lead.urgencyBucket]}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lead.slaHoursSnapshot} saat taahhüt
                      </div>
                    </td>
                    <td>
                      {formatDateTime(lead.slaDueAt)}
                      {lead.breachedAt ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          Aşıldı: {formatDateTime(lead.breachedAt)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className={showcaseLeadBadgeClass(lead.status)}>
                        {SHOWCASE_LEAD_STATUS_LABELS[lead.status]}
                      </span>
                      {lead.fallbackDecision ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          Müşteri kararı:{' '}
                          {lead.fallbackDecision === 'RELEASE' ? 'Pazara aç' : 'Kapalı tut'}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

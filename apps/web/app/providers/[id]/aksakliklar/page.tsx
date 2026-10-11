import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, fetchOrNotFound, formatDateTime, getCurrentUser } from '../../../../lib/api';
import {
  INCIDENT_OVERDUE_LABEL,
  INCIDENT_RESPONSE_GUIDANCE,
  PROVIDER_INCIDENT_STATUS_LABELS,
  providerIncidentStatusClass,
  type ProviderIncident,
  type ProviderIncidentList,
} from '../../../../lib/provider-incidents';
import { SERVICE_ISSUE_REASON_LABELS } from '../../../../lib/service-issue';
import { ProviderShell } from '../../provider-shell';
import { readCreditBalance } from '../../provider-data';

type ProviderIncidentsPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * REL-002 Faz 4 — the service incidents customers reported about this
 * business. Open ones (no decision yet) first, with the response window;
 * decided ones below. Nothing here names a customer: the API does not send
 * one, and the screen loads nothing else that could.
 */
export default async function ProviderIncidentsPage({ params }: ProviderIncidentsPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/aksakliklar`);
  }

  const [list, creditBalance] = await Promise.all([
    // 403 from ProviderAccessGuard is another business's panel: the shared 404.
    fetchOrNotFound(() => apiFetch<ProviderIncidentList>(`/providers/${id}/incidents?state=all`)),
    readCreditBalance(id),
  ]);

  const open = list.items.filter((item) => item.outcome === null);
  const decided = list.items.filter((item) => item.outcome !== null);

  return (
    <ProviderShell user={user} providerId={id} active="incidents" creditBalance={creditBalance}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <span>Hizmet aksaklıkları</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Müşteri bildirimleri</span>
        <h1 className="pdash-page-title">Hizmet aksaklıkları</h1>
        <p className="pdash-page-sub">
          Müşterilerin eşleştiğiniz işlerle ilgili bildirdiği aksaklıklar. Her bildirime kendi
          açıklamanızı ekleyebilirsiniz; ekibimiz iki tarafı da inceleyerek karar verir.
        </p>
      </header>

      <div className="pdash-notice" role="note" data-testid="incident-guidance">
        {INCIDENT_RESPONSE_GUIDANCE}
      </div>

      <section aria-labelledby="incidents-open-title" style={{ marginTop: 24 }}>
        <div className="pdash-section-head">
          <h2 className="pdash-section-title" id="incidents-open-title">
            <span>Açık bildirimler</span>
            <span className="pdash-section-count" data-testid="incident-open-count">
              {open.length}
            </span>
          </h2>
        </div>
        {open.length === 0 ? (
          <div className="pdash-empty" data-testid="incident-open-empty">
            <h3>Açık bildirim yok</h3>
            <p>Karar bekleyen bir hizmet aksaklığı bildirimi bulunmuyor.</p>
          </div>
        ) : (
          <IncidentTable providerId={id} items={open} showDue />
        )}
      </section>

      <section aria-labelledby="incidents-closed-title" style={{ marginTop: 32 }}>
        <div className="pdash-section-head">
          <h2 className="pdash-section-title" id="incidents-closed-title">
            <span>Geçmiş</span>
            <span className="pdash-section-count" data-testid="incident-closed-count">
              {decided.length}
            </span>
          </h2>
        </div>
        {decided.length === 0 ? (
          <div className="pdash-empty" data-testid="incident-closed-empty">
            <h3>Sonuçlanan bildirim yok</h3>
            <p>Ekibimizin karar verdiği bildirimler burada listelenir.</p>
          </div>
        ) : (
          <IncidentTable providerId={id} items={decided} showDue={false} />
        )}
      </section>
    </ProviderShell>
  );
}

function IncidentTable({
  providerId,
  items,
  showDue,
}: {
  providerId: string;
  items: ProviderIncident[];
  showDue: boolean;
}) {
  return (
    <div className="pdash-table-scroll" style={{ marginTop: 12 }}>
      <table className="pdash-table">
        <thead>
          <tr>
            <th scope="col">Bildirim</th>
            <th scope="col">Talep</th>
            <th scope="col">Sebep</th>
            <th scope="col">Bildirim tarihi</th>
            <th scope="col">{showDue ? 'Yanıt beklenen' : 'Karar tarihi'}</th>
            <th scope="col">Durum</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} data-testid="incident-row" data-incident-id={item.id}>
              <td data-label="Bildirim">
                <Link href={`/providers/${providerId}/aksakliklar/${item.id}`}>
                  <strong>{item.incidentNumber}</strong>
                </Link>
              </td>
              <td data-label="Talep">
                <div>{item.request.requestNumber ?? '—'}</div>
                <div className="pdash-card-sub">{item.request.categoryName}</div>
              </td>
              <td data-label="Sebep">{SERVICE_ISSUE_REASON_LABELS[item.reason]}</td>
              <td data-label="Bildirim tarihi">{formatDateTime(item.reportedAt)}</td>
              <td data-label={showDue ? 'Yanıt beklenen' : 'Karar tarihi'}>
                {showDue ? (
                  item.respondedAt ? (
                    <span className="pdash-card-sub">Yanıtınız iletildi</span>
                  ) : (
                    <>
                      <div>{formatDateTime(item.responseDueAt)}</div>
                      {item.responseOverdue ? (
                        <span className="tag tag-outline" data-testid="incident-overdue">
                          {INCIDENT_OVERDUE_LABEL}
                        </span>
                      ) : null}
                    </>
                  )
                ) : item.outcome ? (
                  formatDateTime(item.outcome.decidedAt)
                ) : (
                  '—'
                )}
              </td>
              <td data-label="Durum">
                <span className={providerIncidentStatusClass(item.status)} data-testid="incident-status">
                  {PROVIDER_INCIDENT_STATUS_LABELS[item.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

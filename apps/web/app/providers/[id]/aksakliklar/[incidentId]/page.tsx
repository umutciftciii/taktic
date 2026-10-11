import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, fetchOrNotFound, formatDate, formatDateTime, getCurrentUser } from '../../../../../lib/api';
import {
  INCIDENT_CONFLICT_MESSAGES,
  INCIDENT_OVERDUE_LABEL,
  INCIDENT_RESPONSE_GUIDANCE,
  PROVIDER_INCIDENT_STATUS_LABELS,
  providerIncidentStatusClass,
  type ProviderIncidentDetail,
} from '../../../../../lib/provider-incidents';
import { SERVICE_ISSUE_REASON_LABELS } from '../../../../../lib/service-issue';
import { ProviderShell } from '../../../provider-shell';
import { readCreditBalance } from '../../../provider-data';
import { IncidentResponseForm } from './response-form';

type ProviderIncidentDetailPageProps = {
  params: Promise<{ id: string; incidentId: string }>;
  searchParams?: Promise<{ responded?: string; conflict?: string }>;
};

const DECISION_LABELS = {
  CONFIRMED: PROVIDER_INCIDENT_STATUS_LABELS.CONFIRMED,
  DISMISSED: PROVIDER_INCIDENT_STATUS_LABELS.DISMISSED,
} as const;

/**
 * One incident, as the API's allowlist serves it: the job, the reason, the
 * customer's note with contact details masked, the promised days, the
 * response window and — once decided — the decision with the API's own
 * sentence. Never the customer's identity, the staff rationale or anything
 * about the request's next round.
 */
export default async function ProviderIncidentDetailPage({ params, searchParams }: ProviderIncidentDetailPageProps) {
  const { id, incidentId } = await params;
  const { responded, conflict } = (await searchParams) ?? {};
  const detailPath = `/providers/${id}/aksakliklar/${incidentId}`;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=${detailPath}`);
  }

  const [incident, creditBalance] = await Promise.all([
    fetchOrNotFound(() => apiFetch<ProviderIncidentDetail>(`/providers/${id}/incidents/${incidentId}`)),
    readCreditBalance(id),
  ]);

  const conflictMessage = conflict ? (INCIDENT_CONFLICT_MESSAGES[conflict] ?? null) : null;
  const place = [incident.request.city, incident.request.district].filter(Boolean).join(' / ');
  const undecided = incident.outcome === null;

  return (
    <ProviderShell user={user} providerId={id} active="incidents" creditBalance={creditBalance}>
      <nav className="pdash-crumbs" aria-label="Breadcrumb">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${id}/aksakliklar`}>Hizmet aksaklıkları</Link>
        <span aria-hidden="true">/</span>
        <span>{incident.incidentNumber}</span>
      </nav>

      <header className="pdash-page-head">
        <span className="kicker">Hizmet aksaklığı bildirimi</span>
        <h1 className="pdash-page-title" data-testid="incident-number">
          {incident.incidentNumber}
        </h1>
        <p className="pdash-page-sub">
          {incident.request.categoryName}
          {place ? ` · ${place}` : ''}
          <span style={{ marginLeft: 8 }}>
            <span className={providerIncidentStatusClass(incident.status)} data-testid="incident-status">
              {PROVIDER_INCIDENT_STATUS_LABELS[incident.status]}
            </span>
          </span>
        </p>
      </header>

      {responded && !conflictMessage ? (
        <div className="pdash-notice" role="status" data-testid="incident-response-received">
          Yanıtınız iletildi. Ekibimiz bildirimi inceleyip karar verdiğinde bu sayfada görünür.
        </div>
      ) : null}
      {conflictMessage ? (
        <div className="pdash-notice pdash-notice-error" role="status" data-testid="incident-response-conflict">
          {conflictMessage}
        </div>
      ) : null}

      <div className="pdash-detail-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="pdash-detail-card" aria-labelledby="incident-summary-title">
            <h2 id="incident-summary-title">Bildirim</h2>
            <dl className="pdash-info-grid">
              <div className="pdash-info-row">
                <dt>Talep numarası</dt>
                <dd data-testid="incident-request-number">{incident.request.requestNumber ?? '—'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Kategori</dt>
                <dd>{incident.request.categoryName}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Konum</dt>
                <dd>{place || '—'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Bildirim tarihi</dt>
                <dd>{formatDateTime(incident.reportedAt)}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Bildirim sebebi</dt>
                <dd data-testid="incident-reason">{SERVICE_ISSUE_REASON_LABELS[incident.reason]}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Taahhüt edilen başlangıç</dt>
                <dd>{incident.promisedStartDate ? formatDate(incident.promisedStartDate) : '—'}</dd>
              </div>
              <div className="pdash-info-row">
                <dt>Taahhüt edilen bitiş</dt>
                <dd>{incident.promisedEndDate ? formatDate(incident.promisedEndDate) : '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="pdash-detail-card" aria-labelledby="incident-note-title">
            <h2 id="incident-note-title">Müşterinin açıklaması</h2>
            {incident.customerNote ? (
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }} data-testid="incident-customer-note">
                {incident.customerNote}
              </p>
            ) : (
              <p className="pdash-card-sub" style={{ margin: 0 }}>
                Müşteri ek açıklama yazmadı.
              </p>
            )}
          </section>

          <section className="pdash-detail-card" aria-labelledby="incident-response-title">
            <h2 id="incident-response-title">Yanıtınız</h2>
            {incident.providerResponse !== null ? (
              <>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }} data-testid="incident-response-text">
                  {incident.providerResponse}
                </p>
                {incident.respondedAt ? (
                  <p className="pdash-card-sub" style={{ marginTop: 8 }}>
                    Yanıtınız iletildi · {formatDateTime(incident.respondedAt)}
                  </p>
                ) : null}
              </>
            ) : incident.canRespond ? (
              <IncidentResponseForm providerId={id} incidentId={incident.id} />
            ) : (
              <p className="pdash-card-sub" style={{ margin: 0 }} data-testid="incident-response-none">
                Bu bildirime yanıt verilmedi.
              </p>
            )}
          </section>
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 18 }} aria-label="Bildirim durumu">
          {undecided ? (
            <section className="pdash-detail-card" aria-labelledby="incident-window-title">
              <h2 id="incident-window-title">Yanıt süresi</h2>
              {incident.respondedAt ? (
                <p style={{ margin: 0 }}>Yanıtınız iletildi; ekibimizin kararı bekleniyor.</p>
              ) : (
                <>
                  <p style={{ margin: 0 }}>
                    Yanıt beklenen: <strong data-testid="incident-response-due">{formatDateTime(incident.responseDueAt)}</strong>
                  </p>
                  {incident.responseOverdue ? (
                    <p style={{ marginTop: 8, marginBottom: 0 }}>
                      <span className="tag tag-outline" data-testid="incident-overdue">
                        {INCIDENT_OVERDUE_LABEL}
                      </span>
                    </p>
                  ) : null}
                  <p className="pdash-card-sub" style={{ marginTop: 8, marginBottom: 0 }} data-testid="incident-guidance">
                    {INCIDENT_RESPONSE_GUIDANCE}
                  </p>
                </>
              )}
            </section>
          ) : null}

          {incident.outcome ? (
            <section className="pdash-detail-card" aria-labelledby="incident-outcome-title">
              <h2 id="incident-outcome-title">Karar</h2>
              <p style={{ margin: 0 }}>
                <span
                  className={providerIncidentStatusClass(incident.outcome.decision)}
                  data-testid="incident-decision"
                >
                  {DECISION_LABELS[incident.outcome.decision]}
                </span>
              </p>
              <p style={{ marginTop: 8, marginBottom: 0 }} data-testid="incident-outcome">
                {incident.outcome.message}
              </p>
              <p className="pdash-card-sub" style={{ marginTop: 8, marginBottom: 0 }}>
                Karar tarihi: {formatDateTime(incident.outcome.decidedAt)}
              </p>
              {incident.outcome.corrected ? (
                <p className="pdash-card-sub" style={{ marginTop: 8, marginBottom: 0 }} data-testid="incident-corrected">
                  Bu karar ekibimiz tarafından sonradan düzeltildi.
                </p>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </ProviderShell>
  );
}

import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  requestStatusLabel,
  requireAdmin,
  statusLabel,
} from '../../../lib/api';
import {
  ELIGIBILITY_BASIS_LABELS,
  INCIDENT_DECISION_LABELS,
  MATCH_ROUND_SOURCE_LABELS,
  MATCH_ROUND_STATUS_LABELS,
  PROVIDER_INCIDENT_STATUS_LABELS,
  RELIABILITY_LEVEL_LABELS,
  RELIABILITY_REVIEW_STATUS_LABELS,
  formatRatio,
  hoursLeft,
  incidentStatusBadgeClass,
  reliabilityLevelBadgeClass,
  reviewStatusBadgeClass,
  serviceIncidentErrorMessage,
  type ServiceIncidentDetail,
} from '../../../lib/service-incidents';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { adjudicateIncidentAction, correctIncidentAction } from '../actions';
import { IncidentAdjudicateForm, IncidentCorrectForm } from './incident-decision-forms';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
};

const DONE_MESSAGES: Record<string, string> = {
  decided: 'Karar kaydedildi. Otomatik kredi iadesi yapılmadı.',
  corrected: 'Karar düzeltildi. Önceki karar zaman çizelgesinde duruyor.',
};

/**
 * REL-002 Faz 4 — one service incident: what the customer reported, what the
 * provider answered, the round it failed, the provider's 90-day reliability,
 * the customer's report history, and every decision ever made on it.
 *
 * - The page is SERVICE_INCIDENTS_READ.
 * - Doğrula / Reddet: SERVICE_INCIDENTS_ADJUDICATE, only while undecided.
 * - Kararı düzelt: SERVICE_INCIDENTS_CORRECT (a super admin's alone), only once
 *   decided, carrying the current head for the API's concurrency check.
 *
 * The 72-hour response window is a signal, never a lock; a decision never
 * refunds credit and never lifts the provider's exclusion from the request.
 * The customer signal is internal: a badge here, nothing else.
 */
export default async function ServiceIncidentDetailPage({ params, searchParams }: PageProps) {
  const { can } = await requireAdmin('SERVICE_INCIDENTS_READ');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const incident = await fetchOrNotFound(() =>
    apiFetch<ServiceIncidentDetail>(`/admin/service-incidents/${encodeURIComponent(id)}`),
  );

  const canAdjudicate = can('SERVICE_INCIDENTS_ADJUDICATE');
  const canCorrect = can('SERVICE_INCIDENTS_CORRECT');
  const canOpenRequest = can('REQUESTS_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenOffer = can('OFFERS_READ');
  const canOpenCustomer = can('CUSTOMERS_READ');

  const decided = incident.effective.decision !== 'PENDING' && incident.effective.adjudicationId !== null;
  const effectiveDecision = incident.effective.decision;
  const reliability = incident.providerReliability;
  const reports = incident.customerReports;
  const requestRef = incident.request.requestNumber ?? `#${incident.request.id.slice(-8)}`;
  const errorText = serviceIncidentErrorMessage(query.error);
  const doneText = query.done ? DONE_MESSAGES[query.done] : undefined;
  const windowHoursLeft = incident.response.windowOpen && !incident.response.respondedAt ? hoursLeft(incident.response.dueAt) : 0;

  const facts: SummaryItem[] = [
    {
      label: 'Karar',
      value: effectiveDecision === 'PENDING' ? 'Bekliyor' : INCIDENT_DECISION_LABELS[effectiveDecision],
      note: incident.effective.kind === 'CORRECTION' ? 'düzeltildi' : undefined,
      testId: 'incident-fact-decision',
    },
    { label: 'Bildirildi', value: formatDateTime(incident.reportedAt) },
    {
      label: 'Yanıt',
      value: incident.response.respondedAt ? 'Yanıtladı' : 'Yanıt yok',
      tone: incident.response.overdue ? 'warning' : 'neutral',
      note: incident.response.overdue ? 'Süre geçti' : incident.response.late ? 'Geç yanıt' : undefined,
    },
    {
      label: 'Hizmet veren seviyesi',
      value: RELIABILITY_LEVEL_LABELS[reliability.level],
      note: `${reliability.confirmed} doğrulanmış aksaklık (90g)`,
      tone: reliability.level === 'NORMAL' ? 'neutral' : 'warning',
    },
  ];

  return (
    <main className="refund-detail-page">
      <DetailHeader
        back={{ href: '/service-incidents', label: 'Hizmet aksaklıkları' }}
        badges={
          <span
            className={incidentStatusBadgeClass(incident.status)}
            data-testid="service-incident-status"
            data-status={incident.status}
          >
            {PROVIDER_INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
          </span>
        }
        meta={
          <>
            <code className="cell-break">{incident.incidentNumber}</code> · {incident.round.roundNumber}. tur
          </>
        }
        title={`Hizmet aksaklığı · ${incident.reasonLabel}`}
        subtitle={`${incident.provider.businessName} · ${incident.request.categoryName} · ${incident.request.city}/${incident.request.district}`}
        facts={facts}
        factsLabel="Bildirim özeti"
        testId="incident-header"
      />

      {errorText ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="incident-error">
          {errorText}
        </div>
      ) : doneText ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="incident-done">
          {doneText}
        </div>
      ) : null}

      <div className="detail-panel detail-panel-grid">
        <section className="is-wide" id="karar">
          <SectionCard title="Karar">
            <div className="refund-notices">
              {windowHoursLeft > 0 && !decided ? (
                <p className="notice notice-warning" data-testid="incident-window-open">
                  Hizmet verenin yanıt süresi henüz dolmadı ({windowHoursLeft} saat kaldı). Bu bir uyarıdır; karar
                  vermenizi engellemez.
                </p>
              ) : null}
              {incident.exclusion.exists ? (
                <p className="detail-muted-note" data-testid="incident-exclusion">
                  Hizmet veren bu talepten kalıcı olarak dışlandı — karar bunu değiştirmez.
                </p>
              ) : null}
              <p className="detail-muted-note" data-testid="incident-credit-invariant">
                <strong>Otomatik kredi iadesi yok.</strong> Ne doğrulama ne ret kredi hareketi yapar.
              </p>
              {!decided && !canAdjudicate ? (
                <p className="detail-muted-note" data-testid="incident-no-adjudicate">
                  Karar bekliyor. Karar vermek için hizmet aksaklığı karar yetkisi gerekir.
                </p>
              ) : null}
              {decided && !canCorrect ? (
                <p className="detail-muted-note" data-testid="incident-no-correct">
                  Karar verildi. Bir kararı yalnız süper yönetici düzeltebilir.
                </p>
              ) : null}
            </div>
            {!decided && canAdjudicate ? (
              <IncidentAdjudicateForm incidentId={incident.id} action={adjudicateIncidentAction} />
            ) : null}
            {decided && canCorrect && incident.effective.adjudicationId && effectiveDecision !== 'PENDING' ? (
              <IncidentCorrectForm
                incidentId={incident.id}
                current={effectiveDecision}
                effectiveAdjudicationId={incident.effective.adjudicationId}
                action={correctIncidentAction}
              />
            ) : null}
          </SectionCard>
        </section>

        <SectionCard title="Müşteri bildirimi">
          <KeyValueList
            items={[
              { label: 'Neden', value: incident.reasonLabel, testId: 'incident-reason' },
              {
                label: 'Müşteri notu',
                value: incident.customerNote ? (
                  <span className="detail-prose" data-testid="incident-customer-note">
                    {incident.customerNote}
                  </span>
                ) : (
                  <span className="cell-muted">Not yazılmamış</span>
                ),
              },
              { label: 'Bildirim zamanı', value: formatDateTime(incident.reportedAt) },
              {
                label: 'Uygunluk dayanağı',
                value: ELIGIBILITY_BASIS_LABELS[incident.eligibilityBasis] ?? incident.eligibilityBasis,
              },
              {
                label: 'Müşteri',
                value: canOpenCustomer ? (
                  <Link className="cell-link" href={`/customers/${incident.customer.id}`}>
                    {incident.customer.name ?? 'İsimsiz müşteri'}
                  </Link>
                ) : (
                  incident.customer.name ?? 'İsimsiz müşteri'
                ),
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="Hizmet veren yanıtı">
          <KeyValueList
            items={[
              {
                label: 'Yanıt',
                value: incident.response.text ? (
                  <span className="detail-prose" data-testid="incident-provider-response">
                    {incident.response.text}
                  </span>
                ) : (
                  <span className="cell-muted" data-testid="incident-provider-response">
                    Henüz yanıt yok
                  </span>
                ),
              },
              {
                label: 'Yanıt zamanı',
                value: incident.response.respondedAt ? formatDateTime(incident.response.respondedAt) : null,
              },
              {
                label: 'Yanıt süresi sonu (72 saat)',
                value: (
                  <span className="badge-row">
                    <span>{formatDateTime(incident.response.dueAt)}</span>
                    {incident.response.overdue ? <span className="badge badge-bad">Süre geçti</span> : null}
                    {incident.response.late ? <span className="badge badge-warn">Geç yanıt</span> : null}
                    {windowHoursLeft > 0 ? <span className="badge badge-info">{windowHoursLeft} saat kaldı</span> : null}
                  </span>
                ),
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="Bağlantılar">
          <KeyValueList
            items={[
              {
                label: 'Talep',
                value: (
                  <>
                    {canOpenRequest ? (
                      <Link className="cell-link" href={`/requests/${incident.request.id}`} data-testid="incident-request-link">
                        {requestRef}
                      </Link>
                    ) : (
                      requestRef
                    )}{' '}
                    · {requestStatusLabel(incident.request.status)}
                  </>
                ),
              },
              {
                label: 'Aksaklığın turu',
                value: `${incident.round.roundNumber}. tur · ${MATCH_ROUND_STATUS_LABELS[incident.round.status] ?? incident.round.status} · ${MATCH_ROUND_SOURCE_LABELS[incident.round.source] ?? incident.round.source}`,
                testId: 'incident-round',
              },
              {
                label: 'Talebin şimdiki turu',
                value: incident.request.currentRound
                  ? `${incident.request.currentRound.roundNumber}. tur · ${MATCH_ROUND_STATUS_LABELS[incident.request.currentRound.status] ?? incident.request.currentRound.status}`
                  : null,
              },
              {
                label: 'Teklif',
                value: (
                  <>
                    {canOpenOffer ? (
                      <Link className="cell-link" href={`/offers/${incident.offer.id}`}>
                        <code>{incident.offer.id.slice(-8)}</code>
                      </Link>
                    ) : (
                      <code>{incident.offer.id.slice(-8)}</code>
                    )}{' '}
                    · {statusLabel(incident.offer.status)} · {formatPrice(incident.offer.priceAmount)}
                  </>
                ),
              },
              {
                label: 'Hizmet veren',
                value: canOpenProvider ? (
                  <Link className="cell-link" href={`/providers/${incident.provider.id}`} data-testid="incident-provider-link">
                    {incident.provider.businessName}
                  </Link>
                ) : (
                  incident.provider.businessName
                ),
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="Söz verilen takvim">
          <KeyValueList
            items={[
              {
                label: 'Başlangıç',
                value: incident.schedule.promisedStartDate ? formatDateTime(incident.schedule.promisedStartDate) : null,
              },
              {
                label: 'Bitiş',
                value: incident.schedule.promisedEndDate ? formatDateTime(incident.schedule.promisedEndDate) : null,
              },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Hizmet veren güvenilirliği (90 gün)"
          subtitle="Geçerli kararlardan, her okumada yeniden hesaplanır."
          testId="incident-provider-reliability"
        >
          <KeyValueList
            items={[
              {
                label: 'Seviye',
                value: (
                  <span className={reliabilityLevelBadgeClass(reliability.level)}>
                    {RELIABILITY_LEVEL_LABELS[reliability.level]}
                  </span>
                ),
              },
              { label: 'Doğrulanmış aksaklık', value: String(reliability.confirmed) },
              { label: 'Reddedilen', value: String(reliability.dismissed) },
              { label: 'Karar bekleyen', value: String(reliability.pending) },
              {
                label: 'Yanıt oranı',
                value: `${formatRatio(reliability.responseRate)} (${reliability.responded}/${reliability.total})`,
              },
              {
                label: 'Açık inceleme',
                value: reliability.openReview ? (
                  <span className={reviewStatusBadgeClass(reliability.openReview.status)}>
                    {RELIABILITY_REVIEW_STATUS_LABELS[reliability.openReview.status]}
                  </span>
                ) : (
                  'Yok'
                ),
              },
            ]}
          />
          {canOpenProvider ? (
            <p className="detail-muted-note">
              <Link className="cell-link" href={`/providers/${incident.provider.id}#guvenilirlik`}>
                Hizmet verenin güvenilirlik kartı
              </Link>
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Müşterinin bildirim geçmişi (90 gün)"
          subtitle="Yalnız iç değerlendirme içindir; müşteriye bir kısıt getirmez."
          testId="incident-customer-reports"
        >
          {reports.signal === 'HIGH_DISMISSAL_RATIO' ? (
            <p>
              <span className="badge badge-warn" data-testid="incident-customer-signal">
                Yüksek ret oranı (yalnız iç sinyal)
              </span>
            </p>
          ) : null}
          <KeyValueList
            items={[
              { label: 'Toplam bildirim', value: String(reports.total) },
              { label: 'Doğrulanan', value: String(reports.confirmed) },
              { label: 'Reddedilen', value: String(reports.dismissed) },
              { label: 'Karar bekleyen', value: String(reports.pending) },
              { label: 'Ret oranı', value: formatRatio(reports.dismissedRatio) },
            ]}
          />
        </SectionCard>

        <section className="is-wide">
          <SectionCard title="Karar geçmişi" subtitle="Her karar ve düzeltme, eskiden yeniye. Hiçbiri silinmez.">
            {incident.adjudications.length === 0 ? (
              <p className="detail-muted-note" data-testid="incident-no-adjudications">
                Henüz karar verilmedi.
              </p>
            ) : (
              <ol className="timeline" data-testid="incident-adjudications">
                {incident.adjudications.map((entry) => (
                  <li
                    key={entry.id}
                    className="timeline-item"
                    data-testid="adjudication-entry"
                    data-decision={entry.decision}
                    data-kind={entry.kind}
                    data-effective={entry.effective ? 'true' : 'false'}
                  >
                    <time className="timeline-when" dateTime={entry.decidedAt}>
                      {formatDateTime(entry.decidedAt)}
                    </time>
                    <div className="timeline-body">
                      <p className="timeline-title">
                        {entry.kind === 'CORRECTION' ? 'Düzeltme' : 'İlk karar'} ·{' '}
                        {entry.kind === 'CORRECTION' && entry.previousDecision
                          ? `${INCIDENT_DECISION_LABELS[entry.previousDecision]} → ${INCIDENT_DECISION_LABELS[entry.decision]}`
                          : INCIDENT_DECISION_LABELS[entry.decision]}{' '}
                        {entry.effective ? (
                          <span className="badge badge-good" data-testid="adjudication-effective">
                            Geçerli
                          </span>
                        ) : null}
                      </p>
                      <p className="timeline-meta">{entry.decidedBy?.name ?? 'İsimsiz yönetici'}</p>
                      <p className="timeline-meta detail-prose">{entry.rationale}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </section>
      </div>
    </main>
  );
}

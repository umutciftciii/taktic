import Link from 'next/link';
import {
  apiFetch,
  campaignEventStatusLabel,
  fetchOrNotFound,
  formatDateTime,
  requireAdmin,
} from '../../../lib/api';
import {
  ELIGIBILITY_DECISION_LABELS,
  ELIGIBILITY_TRIGGER_LABELS,
  eligibilitySignalDetails,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../../lib/business-registration';
import { formatCount } from '../../../lib/pagination';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { decideEligibilityAction } from '../actions';
import { EligibilityDecisionForm } from './decision-form';

type PageProps = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
};

/** The one status the queue itself adds to the engine's event states. */
function eventStatusLabel(status: string): string {
  return status === 'HELD_FOR_REVIEW' ? 'İncelemede' : campaignEventStatusLabel(status);
}

/**
 * One held event (CMP-006 PR-C): the snapshot the gate froze when it held it —
 * closed codes, counts, other account ids and keyed fingerprints; no number,
 * address or phone is stored — and the one decision it may receive.
 *
 * ADMIN-DESIGN-001 Faz 3E: the shared detail template — the summary card with
 * the decision as its badge, then the event, the frozen reasons and the
 * decision. The decision is still final and single: the form now asks first
 * (`EligibilityDecisionForm`), and the API still refuses a second one.
 */
export default async function PromotionEligibilityDetailPage({ params, searchParams }: PageProps) {
  // The decision form needs no extra gate: its route asks for the same
  // PROMOTION_ELIGIBILITY_REVIEW this screen already requires.
  const { can } = await requireAdmin('PROMOTION_ELIGIBILITY_REVIEW');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenCampaign = can('CAMPAIGNS_READ');
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const hold = await fetchOrNotFound(() =>
    apiFetch<PromotionEligibilityHoldView>(`/admin/promotion-eligibility/holds/${encodeURIComponent(eventId)}`),
  );
  const decidable = !hold.review && hold.eventStatus === 'HELD_FOR_REVIEW';
  const candidates = hold.candidateCampaigns ?? [];

  const facts: SummaryItem[] = [
    { label: 'Tetikleyici', value: ELIGIBILITY_TRIGGER_LABELS[hold.trigger] ?? hold.trigger },
    { label: 'İncelemeye alınma', value: formatDateTime(hold.heldAt) },
    { label: 'Gerekçe', value: `${formatCount(hold.snapshot.signals.length)} sinyal` },
    { label: 'Aday kampanya', value: formatCount(candidates.length) },
  ];

  const providerName = canOpenProvider ? (
    <Link className="cell-link" href={`/providers/${hold.provider.id}`}>
      {hold.provider.businessName}
    </Link>
  ) : (
    hold.provider.businessName
  );

  return (
    <main className="eligibility-detail-page">
      <DetailHeader
        back={{ href: '/promotion-eligibility', label: 'Uygunluk incelemesi' }}
        badges={
          hold.review ? (
            <span
              className={hold.review.decision === 'ELIGIBLE' ? 'badge badge-good' : 'badge badge-bad'}
              data-testid="eligibility-badge"
              data-decision={hold.review.decision}
            >
              {hold.review.decision === 'ELIGIBLE' ? 'Uygun' : 'Uygun değil'}
            </span>
          ) : decidable ? (
            <span className="badge badge-warn" data-testid="eligibility-badge" data-decision="">
              Karar bekliyor
            </span>
          ) : (
            <span className="badge badge-muted" data-testid="eligibility-badge" data-decision="">
              İncelemede değil
            </span>
          )
        }
        meta={<code className="cell-break">{hold.triggerEventKey}</code>}
        title={`Uygunluk incelemesi · ${hold.provider.businessName}`}
        subtitle="Giriş promosyonu için incelemeye alınan olay. Karar gerekçeyle bir kez verilir."
        facts={facts}
        factsLabel="İnceleme özeti"
        testId="eligibility-header"
      />

      {query.error ? (
        <div className="notice notice-error detail-notice" role="alert" data-testid="eligibility-error">
          {query.error}
        </div>
      ) : null}
      {query.done ? (
        <div className="notice notice-success detail-notice" role="status" data-testid="eligibility-done">
          Karar kaydedildi.
        </div>
      ) : null}

      <div className="detail-panel detail-panel-grid">
        <SectionCard title="Olay">
          <KeyValueList
            items={[
              { label: 'Hizmet veren', value: providerName },
              { label: 'Tetikleyici', value: ELIGIBILITY_TRIGGER_LABELS[hold.trigger] ?? hold.trigger },
              { label: 'İncelemeye alınma', value: formatDateTime(hold.heldAt) },
              {
                label: 'Olay durumu',
                value: (
                  <span data-testid="eligibility-event-status" data-status={hold.eventStatus}>
                    {eventStatusLabel(hold.eventStatus)} <code className="cell-muted">{hold.eventStatus}</code>
                  </span>
                ),
              },
              {
                label: 'Aday kampanyalar',
                value:
                  candidates.length === 0 ? null : (
                    <span className="cell-stack">
                      {candidates.map((campaign) =>
                        canOpenCampaign ? (
                          <Link key={campaign.id} className="cell-link" href={`/campaigns/${campaign.id}`}>
                            {campaign.name}
                          </Link>
                        ) : (
                          <span key={campaign.id}>{campaign.name}</span>
                        ),
                      )}
                    </span>
                  ),
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="İnceleme anındaki gerekçeler" subtitle="Kapı olayı incelemeye aldığı anda dondurulan kayıt; değişmez.">
          <ul className="eligibility-signal-list" data-testid="eligibility-signals">
            {hold.snapshot.signals.map((signal) => (
              <li key={signal.code} data-code={signal.code}>
                <strong>{eligibilitySignalLabel(signal.code)}</strong>
                {eligibilitySignalDetails(signal).map((detail) => (
                  <span key={detail} className="detail-muted-note">
                    {detail}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </SectionCard>

        <section className="is-wide" id="karar">
          <SectionCard title="Karar" subtitle={hold.review ? undefined : 'Tek seferlik ve kesin; aynı IP tek başına hiçbir zaman ret gerekçesi değildir.'}>
            {hold.review ? (
              <div data-testid="eligibility-review">
                <KeyValueList
                  items={[
                    {
                      label: 'Karar',
                      value: <span data-testid="eligibility-decision">{ELIGIBILITY_DECISION_LABELS[hold.review.decision]}</span>,
                    },
                    { label: 'Gerekçe', value: <span className="detail-prose">{hold.review.reason}</span> },
                    {
                      label: 'Karar veren',
                      value: hold.review.decidedBy.name ?? hold.review.decidedBy.email ?? hold.review.decidedBy.id,
                    },
                    { label: 'Zaman', value: formatDateTime(hold.review.decidedAt) },
                  ]}
                />
              </div>
            ) : decidable ? (
              <EligibilityDecisionForm
                eventId={hold.eventId}
                providerName={hold.provider.businessName}
                action={decideEligibilityAction}
              />
            ) : (
              <p className="detail-muted-note">Bu olay artık incelemede değil.</p>
            )}
          </SectionCard>
        </section>
      </div>
    </main>
  );
}

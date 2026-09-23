import Link from 'next/link';
import { apiFetch, fetchOrNotFound, formatDateTime, requireAdmin } from '../../../lib/api';
import {
  ELIGIBILITY_DECISION_LABELS,
  ELIGIBILITY_TRIGGER_LABELS,
  eligibilitySignalDetails,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../../lib/business-registration';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { decideEligibilityAction } from '../actions';

type PageProps = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ done?: string; error?: string }>;
};

/**
 * One held event (CMP-006 PR-C): the snapshot the gate froze when it held it —
 * closed codes, counts, other account ids and keyed fingerprints; no number,
 * address or phone is stored — and the one decision it may receive.
 */
export default async function PromotionEligibilityDetailPage({ params, searchParams }: PageProps) {
  await requireAdmin('PROMOTION_ELIGIBILITY_REVIEW');
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const hold = await fetchOrNotFound(() =>
    apiFetch<PromotionEligibilityHoldView>(`/admin/promotion-eligibility/holds/${encodeURIComponent(eventId)}`),
  );
  const decidable = !hold.review && hold.eventStatus === 'HELD_FOR_REVIEW';

  return (
    <main>
      <PageHeader title={`Uygunluk incelemesi · ${hold.provider.businessName}`} subtitle={hold.triggerEventKey} />
      <p style={{ marginBottom: 12 }}>
        <Link className="cell-link" href="/promotion-eligibility">
          ← Kuyruğa dön
        </Link>
      </p>

      {query.error ? (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }} data-testid="eligibility-error">
          {query.error}
        </div>
      ) : null}
      {query.done ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }} data-testid="eligibility-done">
          Karar kaydedildi.
        </div>
      ) : null}

      <div className="detail-grid">
        <SectionCard title="Olay">
          <dl className="meta-row">
            <dt>Hizmet veren</dt>
            <dd>
              <Link className="cell-link" href={`/providers/${hold.provider.id}`}>
                {hold.provider.businessName}
              </Link>
            </dd>
            <dt>Tetikleyici</dt>
            <dd>{ELIGIBILITY_TRIGGER_LABELS[hold.trigger] ?? hold.trigger}</dd>
            <dt>İncelemeye alınma</dt>
            <dd>{formatDateTime(hold.heldAt)}</dd>
            <dt>Olay durumu</dt>
            <dd data-testid="eligibility-event-status">{hold.eventStatus}</dd>
            <dt>Aday kampanyalar</dt>
            <dd>
              {(hold.candidateCampaigns ?? []).length === 0
                ? '—'
                : (hold.candidateCampaigns ?? []).map((campaign) => (
                    <Link key={campaign.id} className="cell-link" href={`/campaigns/${campaign.id}`} style={{ marginRight: 8 }}>
                      {campaign.name}
                    </Link>
                  ))}
            </dd>
          </dl>
        </SectionCard>

        <SectionCard title="İnceleme anındaki gerekçeler (değişmez)">
          <ul className="plain-list" data-testid="eligibility-signals">
            {hold.snapshot.signals.map((signal) => (
              <li key={signal.code} data-code={signal.code}>
                <strong>{eligibilitySignalLabel(signal.code)}</strong>
                {eligibilitySignalDetails(signal).map((detail) => (
                  <div key={detail} className="cell-muted" style={{ fontSize: 12 }}>
                    {detail}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Karar">
          {hold.review ? (
            <dl className="meta-row" data-testid="eligibility-review">
              <dt>Karar</dt>
              <dd data-testid="eligibility-decision">{ELIGIBILITY_DECISION_LABELS[hold.review.decision]}</dd>
              <dt>Gerekçe</dt>
              <dd>{hold.review.reason}</dd>
              <dt>Karar veren</dt>
              <dd>{hold.review.decidedBy.name ?? hold.review.decidedBy.email ?? hold.review.decidedBy.id}</dd>
              <dt>Zaman</dt>
              <dd>{formatDateTime(hold.review.decidedAt)}</dd>
            </dl>
          ) : decidable ? (
            <form action={decideEligibilityAction} data-testid="eligibility-form">
              <input type="hidden" name="eventId" value={hold.eventId} />
              <label className="form-row" htmlFor="eligibility-decision">
                <span>Karar</span>
                <select id="eligibility-decision" name="decision" required defaultValue="" data-testid="eligibility-decision-select">
                  <option value="" disabled>
                    Seçin
                  </option>
                  {(['ELIGIBLE', 'INELIGIBLE'] as const).map((decision) => (
                    <option key={decision} value={decision}>
                      {ELIGIBILITY_DECISION_LABELS[decision]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row" htmlFor="eligibility-reason">
                <span>Gerekçe (10–1000 karakter, denetim kaydına yazılır)</span>
                <textarea id="eligibility-reason" name="reason" rows={4} required minLength={10} maxLength={1000} data-testid="eligibility-reason" />
              </label>
              <p className="muted" style={{ fontSize: 12 }}>
                Gerekçeye kimlik, vergi veya sicil numarası, telefon ya da IP adresi yazmayın. Karar bir kez verilir ve
                değiştirilemez; “Uygun” kararı olayı bir kez yeniden değerlendirmeye alır ve kampanya limitleri yine
                uygulanır.
              </p>
              <button className="btn btn-primary btn-sm" type="submit" data-testid="eligibility-submit">
                Kararı kaydet
              </button>
            </form>
          ) : (
            <p className="muted">Bu olay artık incelemede değil.</p>
          )}
        </SectionCard>
      </div>
    </main>
  );
}

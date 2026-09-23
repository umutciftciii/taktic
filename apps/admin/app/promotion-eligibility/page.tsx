import Link from 'next/link';
import { apiFetch, formatDateTime, requireAdmin } from '../../lib/api';
import {
  ELIGIBILITY_DECISION_LABELS,
  ELIGIBILITY_TRIGGER_LABELS,
  eligibilitySignalLabel,
  type PromotionEligibilityHoldView,
} from '../../lib/business-registration';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

type PageProps = { searchParams: Promise<{ filter?: string }> };

/**
 * CMP-006 PR-C — the promotion eligibility queue: introductory promotion
 * events the gate held for a person. A held event is never retried by the
 * worker; it waits here until someone decides it, once, with a reason.
 */
export default async function PromotionEligibilityPage({ searchParams }: PageProps) {
  await requireAdmin('PROMOTION_ELIGIBILITY_REVIEW');
  const filter = (await searchParams).filter === 'decided' ? 'decided' : 'open';
  const { items } = await apiFetch<{ items: PromotionEligibilityHoldView[] }>(
    `/admin/promotion-eligibility/holds?filter=${filter}`,
  );

  return (
    <main>
      <PageHeader
        title="Uygunluk İncelemesi"
        subtitle="Giriş promosyonu için incelemeye alınan hizmet verenler. Karar gerekçeyle bir kez verilir; aynı IP tek başına hiçbir zaman ret gerekçesi değildir."
      />

      <nav className="inline-actions" style={{ marginBottom: 12 }}>
        <Link className={filter === 'open' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} href="/promotion-eligibility">
          Bekleyen
        </Link>
        <Link
          className={filter === 'decided' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
          href="/promotion-eligibility?filter=decided"
        >
          Karar verilen
        </Link>
      </nav>

      <SectionCard title={filter === 'open' ? 'Bekleyen incelemeler' : 'Karar verilen incelemeler'}>
        {items.length === 0 ? (
          <EmptyState
            title={filter === 'open' ? 'Bekleyen inceleme yok' : 'Henüz karar verilmedi'}
            description="Kampanya motoru bir giriş promosyonunu incelemeye aldığında burada görünür."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="eligibility-table">
              <thead>
                <tr>
                  <th>Hizmet veren</th>
                  <th>Tetikleyici</th>
                  <th>Gerekçeler</th>
                  <th>İncelemeye alınma</th>
                  <th>Karar</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.eventId} data-testid="eligibility-row" data-event={item.eventId}>
                    <td>
                      <Link className="cell-link" href={`/providers/${item.provider.id}`}>
                        {item.provider.businessName}
                      </Link>
                    </td>
                    <td>{ELIGIBILITY_TRIGGER_LABELS[item.trigger] ?? item.trigger}</td>
                    <td>
                      <div className="cell-stack">
                        {item.snapshot.signals.map((signal) => (
                          <span key={signal.code}>{eligibilitySignalLabel(signal.code)}</span>
                        ))}
                      </div>
                    </td>
                    <td>{formatDateTime(item.heldAt)}</td>
                    <td>{item.review ? ELIGIBILITY_DECISION_LABELS[item.review.decision] : <span className="cell-muted">—</span>}</td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" href={`/promotion-eligibility/${item.eventId}`}>
                        Detay
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </main>
  );
}

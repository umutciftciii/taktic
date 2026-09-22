import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcaseStatusBadgeClass,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_CARD_STATUS_LABELS,
  type ShowcaseCardListEntry,
  type ShowcaseCardStatus,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const STATUSES: ShowcaseCardStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'ARCHIVED',
];

type ShowcaseCardsPageProps = {
  searchParams: Promise<{ status?: string }>;
};

/**
 * Every vitrin card in the system, whoever owns it.
 *
 * The queue next door answers "what is waiting on me"; this answers "what
 * exists". They are different questions and a filter on one list would not
 * serve both — an operator investigating a complaint about a price needs to find
 * an approved card, which by definition is not in the review queue.
 *
 * Read-only, like the queue. Every action on a card is a decision about one of
 * its versions, and those live on the version's own screen.
 */
export default async function ShowcaseCardsPage({ searchParams }: ShowcaseCardsPageProps) {
  await requireAdmin('SHOWCASE_CARDS_READ');

  const { status } = await searchParams;
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;
  const query = selected ? `?status=${selected}` : '';
  const cards = await apiFetch<ShowcaseCardListEntry[]>(`/admin/showcase/cards${query}`);

  return (
    <>
      <PageHeader
        title="Vitrin Kartları"
        subtitle="Sistemdeki bütün vitrin kartları ve bulundukları durum."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vitrin Kartları' }]}
      />

      <SectionCard
        title="Kartlar"
        subtitle={`${cards.length} kart listeleniyor.`}
        actions={
          <span className="inline-actions">
            <Link
              className={`btn btn-sm ${selected ? 'btn-secondary' : 'btn-primary'}`}
              href="/showcase/cards"
            >
              Tümü
            </Link>
            {STATUSES.map((candidate) => (
              <Link
                key={candidate}
                className={`btn btn-sm ${selected === candidate ? 'btn-primary' : 'btn-secondary'}`}
                href={`/showcase/cards?status=${candidate}`}
              >
                {SHOWCASE_CARD_STATUS_LABELS[candidate]}
              </Link>
            ))}
          </span>
        }
        padded={false}
      >
        {cards.length === 0 ? (
          <EmptyState
            title="Kart yok"
            description="Bu filtreye uyan bir vitrin kartı bulunmuyor."
          />
        ) : (
          <div className="table-scroll showcase-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kart</th>
                  <th>İşletme</th>
                  <th>Tür</th>
                  <th>Hizmet bedeli</th>
                  <th>Durum</th>
                  <th>Güncelleme</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => {
                  const shown = card.liveVersion ?? card.draftVersion;
                  const price = shown?.listedServicePriceAmount ?? null;
                  const reviewable =
                    card.draftVersion?.reviewStatus === 'PENDING' ? card.draftVersion : null;

                  return (
                    <tr key={card.id}>
                      <td>
                        {reviewable ? (
                          <Link href={`/showcase/reviews/${reviewable.id}`}>
                            {shown?.title ?? 'Adsız kart'}
                          </Link>
                        ) : (
                          (shown?.title ?? 'Adsız kart')
                        )}
                        <div className="cell-muted">{card.category.name}</div>
                      </td>
                      <td>
                        <Link href={`/providers/${card.provider.id}`}>
                          {card.provider.businessName}
                        </Link>
                      </td>
                      <td>{SHOWCASE_CARD_KIND_LABELS[card.kind]}</td>
                      <td>
                        {price === null ? (
                          <span className="cell-muted">Sabit fiyat yok</span>
                        ) : (
                          formatPrice(price, shown?.listedServiceCurrency ?? 'TRY')
                        )}
                      </td>
                      <td>
                        <span className={showcaseStatusBadgeClass(card.status)}>
                          {SHOWCASE_CARD_STATUS_LABELS[card.status]}
                        </span>
                      </td>
                      <td>{formatDateTime(card.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

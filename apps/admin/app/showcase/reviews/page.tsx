import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcaseReviewBadgeClass,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_VERSION_REVIEW_LABELS,
  type ShowcaseVersionListEntry,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { WholeListFooter } from '../../../components/pagination';

/**
 * Onay bekleyen kartlar (#17), design `list:cardReviews` (paket 2
 * `31-vitrin-onay-bekleyen-kartlar`, ADMIN-DESIGN-001 Faz 3C).
 *
 * The vitrin review queue: card versions waiting on an operator.
 *
 * Oldest submission first, because a queue ordered newest-first leaves the
 * provider who has waited longest at the bottom of the screen.
 *
 * Every row is one *version*, not one card. That is the unit an operator decides
 * about: a card may have been approved twice already and be here for its third
 * text, and the decision is about the text — which is also why
 * `ShowcaseCardReview` keys on the version and not the card.
 *
 * The list is read-only. Approving from a row would mean deciding without having
 * read the scope, the price and the areas, and those are what the decision is.
 *
 * The API returns the whole queue in one answer, so the count in the summary is
 * the queue's real size and there is no next page. Not drawn from the design:
 * its Ara, Durum and Tarih filters (the queue is one state, and the API takes
 * no search or date).
 */

/** The design's ⓘ, fitted to what an approval actually does (admin-showcase.service.ts). */
const SCREEN_INFO =
  'Vitrin kartı, bir işletmenin belirli bir hizmeti kendi fiyatıyla ilan ettiği reklamdır. Kartın her yeni metni yayına girmeden önce bir kişi tarafından okunur: abartılı iddia, yanlış fiyat ve iletişim bilgisi paylaşımı aranır. İlk sürümü onaylanan kart, geçerli bir yayın hakkı varsa hemen yayına girer; yayındaki bir kartın yeni sürümü onaylanınca yayındaki metin değişir, yayın süresi değişmez. Karar, sürümün kendi ekranında verilir.';

const COLUMNS: DataColumn[] = [
  { key: 'card', label: 'Kart' },
  { key: 'provider', label: 'İşletme' },
  { key: 'kind', label: 'Tür' },
  { key: 'price', label: 'İlan ettiği fiyat', align: 'end' },
  { key: 'areas', label: 'Bölge' },
  { key: 'submittedAt', label: 'Gönderim' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function ShowcaseReviewQueuePage() {
  const { can } = await requireAdmin('SHOWCASE_REVIEW_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');

  const versions = await apiFetch<ShowcaseVersionListEntry[]>('/admin/showcase/versions');

  const summary =
    versions.length === 0
      ? 'Okunmayı bekleyen kart yok'
      : `${versions.length} kart okunmayı bekliyor · en eski gönderim başta`;

  return (
    <main className="showcase-reviews-page">
      <PageHeader
        title="Onay bekleyen kartlar"
        subtitle={summary}
        info={SCREEN_INFO}
        /*
          The full card list, one click from the queue as the design has it. An
          operator comes looking for "every card, in every state" while already
          inside vitrin — usually from a card they have just decided about.
        */
        actions={
          can('SHOWCASE_CARDS_READ') ? (
            <Link className="btn btn-primary" href="/showcase/cards" data-testid="showcase-all-cards-link">
              Tüm vitrin kartları
            </Link>
          ) : undefined
        }
      />

      <div className="data-list-card">
        {versions.length === 0 ? (
          <EmptyState
            title="Bekleyen sürüm yok"
            description="Bir hizmet veren kartını incelemeye gönderdiğinde burada, en eski gönderim başta olacak şekilde listelenir."
          />
        ) : (
          <DataTable caption="Onay bekleyen kartlar" columns={COLUMNS} minWidth={1040} testId="showcase-review-queue">
            {versions.map((version) => (
              <tr key={version.id} data-testid="showcase-review-row" data-version-id={version.id}>
                <td>
                  <div className="cell-stack">
                    <Link className="cell-link" href={`/showcase/reviews/${version.id}`}>
                      <strong className="cell-break" id={`showcase-review-title-${version.id}`}>
                        {version.title}
                      </strong>
                    </Link>
                    <span className="cell-muted">
                      {version.card.category.name} · {version.versionNumber}. sürüm
                      {version.card.liveVersion ? ' · yayındaki metni değiştirir' : ' · ilk yayın'}
                    </span>
                  </div>
                </td>
                <td>
                  {canOpenProvider ? (
                    <Link className="cell-link" href={`/providers/${version.provider.id}`}>
                      {version.provider.businessName}
                    </Link>
                  ) : (
                    version.provider.businessName
                  )}
                </td>
                <td>{SHOWCASE_CARD_KIND_LABELS[version.kind]}</td>
                <td className="is-num">
                  {version.listedServicePriceAmount === null ? (
                    <strong>Sabit fiyat yok</strong>
                  ) : (
                    <strong>{formatPrice(version.listedServicePriceAmount, version.listedServiceCurrency)}</strong>
                  )}
                </td>
                <td>{version.areas.length} bölge</td>
                <td>
                  {version.submittedAt ? formatDateTime(version.submittedAt) : <span className="cell-muted">—</span>}
                </td>
                <td>
                  <span className={showcaseReviewBadgeClass(version.reviewStatus)}>
                    {SHOWCASE_VERSION_REVIEW_LABELS[version.reviewStatus]}
                  </span>
                </td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`/showcase/reviews/${version.id}`}
                    aria-describedby={`showcase-review-title-${version.id}`}
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {versions.length > 0 ? (
          <WholeListFooter count={versions.length} noun="sürüm" summaryTestId="showcase-review-count" />
        ) : null}
      </div>
    </main>
  );
}

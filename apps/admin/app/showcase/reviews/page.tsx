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
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

/**
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
 */
export default async function ShowcaseReviewQueuePage() {
  const { can } = await requireAdmin('SHOWCASE_REVIEW_READ');

  const versions = await apiFetch<ShowcaseVersionListEntry[]>('/admin/showcase/versions');

  return (
    <>
      <PageHeader
        title="Kart İncelemeleri"
        subtitle="İnceleme bekleyen vitrin kartı sürümleri. En eski gönderim başta."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Kart İncelemeleri' }]}
      />

      <SectionCard
        title="Bekleyen sürümler"
        subtitle={`${versions.length} sürüm inceleme bekliyor.`}
        /*
          The full card list, reachable from the queue rather than from the
          sidebar. An operator comes looking for "every card, in every state"
          while already inside vitrin — usually from a card they have just
          decided about — and it does not earn a permanent row beside the three
          jobs the sidebar names.
        */
        actions={
          can('SHOWCASE_CARDS_READ') ? (
            <Link className="btn btn-sm btn-secondary" href="/showcase/cards">
              Tüm vitrin kartları
            </Link>
          ) : undefined
        }
        padded={false}
      >
        {versions.length === 0 ? (
          <EmptyState
            title="Bekleyen sürüm yok"
            description="İnceleme bekleyen bir vitrin kartı sürümü bulunmuyor."
          />
        ) : (
          /*
            Both classes, exactly as the support queue carries both of its own:
            `.table-scroll` only gets its `overflow-x` inside a `.table-card`,
            and this table lives in a `.section-card`. Without the second class
            the seven columns widen the document itself on a 320px phone instead
            of scrolling inside their own box.
          */
          <div className="table-scroll showcase-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kart</th>
                  <th>İşletme</th>
                  <th>Tür</th>
                  <th>Hizmet bedeli</th>
                  <th>Bölge</th>
                  <th>Gönderim</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      <Link href={`/showcase/reviews/${version.id}`}>{version.title}</Link>
                      <div className="cell-muted">
                        {version.card.category.name} · sürüm {version.versionNumber}
                      </div>
                    </td>
                    <td>{version.provider.businessName}</td>
                    <td>{SHOWCASE_CARD_KIND_LABELS[version.kind]}</td>
                    <td>
                      {version.listedServicePriceAmount === null ? (
                        <span className="cell-muted">Sabit fiyat yok</span>
                      ) : (
                        formatPrice(version.listedServicePriceAmount, version.listedServiceCurrency)
                      )}
                    </td>
                    <td>{version.areas.length}</td>
                    <td>
                      {version.submittedAt ? (
                        formatDateTime(version.submittedAt)
                      ) : (
                        <span className="cell-muted">-</span>
                      )}
                    </td>
                    <td>
                      <span className={showcaseReviewBadgeClass(version.reviewStatus)}>
                        {SHOWCASE_VERSION_REVIEW_LABELS[version.reviewStatus]}
                      </span>
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

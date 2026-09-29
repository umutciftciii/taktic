import Link from 'next/link';
import {
  ApiError,
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
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { WholeListFooter } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import { rethrowNextControlFlow } from '../../../lib/next-control-flow';

const STATUSES: ShowcaseCardStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'ARCHIVED',
];

const PATH = '/showcase/cards';

type ShowcaseCardsPageProps = {
  searchParams: Promise<{ status?: string; cardId?: string }>;
};

/**
 * Vitrin kartları (#19). The design has no screen for it (class C), so it is
 * the shared list template (ADMIN-DESIGN-001 Faz 3C).
 *
 * Every vitrin card in the system, whoever owns it.
 *
 * The queue next door answers "what is waiting on me"; this answers "what
 * exists". They are different questions and a filter on one list would not
 * serve both — an operator investigating a complaint about a price needs to find
 * an approved card, which by definition is not in the review queue.
 *
 * Read-only, like the queue. Every decision about a card's text is taken on one
 * of its versions' screens, and "Aç" goes to the version that matters now: the
 * one waiting for review, else the one live, else the last one refused.
 *
 * Deliberately not drawn (K9): "Kartı askıya al / aç". The API has the two
 * routes (`SHOWCASE_CARDS_MODERATE`), but no screen has ever called them and
 * their product rules — what the provider is told, which runs stop, whether
 * the clock stops — have not been decided for an operator. A button here would
 * be the first caller of an untested path.
 *
 * `?cardId=` — the link the consent ledger (/showcase/price-terms) writes —
 * shows that one card, read from `GET /admin/showcase/cards/:cardId`; before
 * this slice the parameter was ignored and the link landed on the whole list.
 */

const SCREEN_INFO =
  'Sistemdeki bütün vitrin kartları, hangi işletmenin olursa olsun ve hangi durumda olursa olsun. Onay kuyruğu yalnız okunmayı bekleyenleri gösterir; bir şikayette yayındaki ya da reddedilmiş bir kartı burada bulursunuz. Kartın metni ve fiyatı hakkındaki kararlar sürümün kendi ekranında verilir; buradan kart düzenlenmez, askıya alınmaz ve silinmez.';

const COLUMNS: DataColumn[] = [
  { key: 'card', label: 'Kart' },
  { key: 'provider', label: 'İşletme' },
  { key: 'kind', label: 'Tür' },
  { key: 'price', label: 'İlan ettiği fiyat', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'updatedAt', label: 'Güncelleme' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function ShowcaseCardsPage({ searchParams }: ShowcaseCardsPageProps) {
  const { can } = await requireAdmin('SHOWCASE_CARDS_READ');
  const canOpenReview = can('SHOWCASE_REVIEW_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');

  const { status, cardId: rawCardId } = await searchParams;
  const cardId = (rawCardId ?? '').trim();
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;

  // One card, when the link names one; the whole list (unpaged, as the API
  // returns it) otherwise, split by status here so the counters are exact.
  const single = cardId ? await readOneCard(cardId) : undefined;
  const all = single === undefined ? await apiFetch<ShowcaseCardListEntry[]>('/admin/showcase/cards') : [];
  const cards = single !== undefined ? (single ? [single] : []) : selected ? all.filter((card) => card.status === selected) : all;

  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: all.length, testId: 'card-view-all' },
    ...STATUSES.map((value) => ({
      key: value,
      label: SHOWCASE_CARD_STATUS_LABELS[value],
      count: all.filter((card) => card.status === value).length,
      testId: `card-view-${value.toLowerCase()}`,
    })),
  ];

  const summary =
    single !== undefined
      ? 'Tek kart gösteriliyor'
      : all.length === 0
        ? 'Henüz vitrin kartı yok'
        : // "incelemede" counts a waiting version, not the card status: an approved
          // card whose next text is in the queue is waiting on an operator too.
          `${all.length} kart · ${all.filter((card) => card.status === 'APPROVED').length} tanesi onaylı · ${
            all.filter((card) => card.draftVersion?.reviewStatus === 'PENDING').length
          } tanesinin sürümü incelemede`;

  return (
    <main className="showcase-cards-page">
      <PageHeader
        title="Vitrin kartları"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          canOpenReview ? (
            <Link className="btn btn-secondary" href="/showcase/reviews">
              Onay bekleyen kartlar
            </Link>
          ) : undefined
        }
      />

      {single !== undefined ? (
        <p className="detail-muted-note" data-testid="card-single-filter">
          {single ? 'Bağlantının gösterdiği kart.' : 'Bu bağlantının gösterdiği kart bulunamadı.'}{' '}
          <Link href={PATH}>Tüm kartlar</Link>
        </p>
      ) : (
        <SavedViewTabs
          label="Kart durumu"
          items={views}
          active={selected ?? ''}
          path={PATH}
          params={{ status: selected ?? '' }}
          param="status"
          testId="card-views"
        />
      )}

      <div className="data-list-card">
        {cards.length === 0 ? (
          <EmptyState
            title="Kart yok"
            description={
              selected || single !== undefined
                ? 'Bu filtreye uyan bir vitrin kartı bulunmuyor.'
                : 'Bir hizmet veren ilk vitrin kartını oluşturduğunda burada listelenir.'
            }
          />
        ) : (
          <DataTable caption="Vitrin kartları" columns={COLUMNS} minWidth={960} testId="card-table">
            {cards.map((card) => {
              const shown = card.liveVersion ?? card.draftVersion ?? card.rejectedVersion;
              const price = shown?.listedServicePriceAmount ?? null;
              // The version that matters now: waiting for review, else live, else the last refusal.
              const target =
                card.draftVersion?.reviewStatus === 'PENDING'
                  ? card.draftVersion
                  : (card.liveVersion ?? card.rejectedVersion);
              const title = shown?.title ?? 'Adsız kart';

              return (
                <tr key={card.id} data-testid="card-row" data-status={card.status} data-card-id={card.id}>
                  <td>
                    <div className="cell-stack">
                      <strong className="cell-break" id={`card-title-${card.id}`}>
                        {title}
                      </strong>
                      <span className="cell-muted">
                        {card.category.name}
                        {shown ? ` · ${shown.versionNumber}. sürüm` : ''}
                        {card.draftVersion?.reviewStatus === 'PENDING' ? ' · yeni sürüm incelemede' : ''}
                      </span>
                    </div>
                  </td>
                  <td>
                    {canOpenProvider ? (
                      <Link className="cell-link" href={`/providers/${card.provider.id}`}>
                        {card.provider.businessName}
                      </Link>
                    ) : (
                      card.provider.businessName
                    )}
                  </td>
                  <td>{SHOWCASE_CARD_KIND_LABELS[card.kind]}</td>
                  <td className="is-num">
                    {price === null ? (
                      <span className="cell-muted">Sabit fiyat yok</span>
                    ) : (
                      formatPrice(price, shown?.listedServiceCurrency ?? 'TRY')
                    )}
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span className={showcaseStatusBadgeClass(card.status)}>
                        {SHOWCASE_CARD_STATUS_LABELS[card.status]}
                      </span>
                      {card.suspendedAt ? (
                        <span className="cell-muted">Askıda: {formatDateTime(card.suspendedAt)}</span>
                      ) : null}
                      {card.archivedAt ? (
                        <span className="cell-muted">Arşiv: {formatDateTime(card.archivedAt)}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>{formatDateTime(card.updatedAt)}</td>
                  <td className="col-actions">
                    {target && canOpenReview ? (
                      <Link
                        className="btn btn-secondary btn-sm"
                        href={`/showcase/reviews/${target.id}`}
                        aria-describedby={`card-title-${card.id}`}
                      >
                        Aç
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {cards.length > 0 ? <WholeListFooter count={cards.length} noun="kart" summaryTestId="card-count" /> : null}
      </div>
    </main>
  );
}

/** One card by id; `null` when the API says there is no such card. */
async function readOneCard(cardId: string): Promise<ShowcaseCardListEntry | null> {
  try {
    return await apiFetch<ShowcaseCardListEntry>(`/admin/showcase/cards/${encodeURIComponent(cardId)}`);
  } catch (error) {
    rethrowNextControlFlow(error);
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

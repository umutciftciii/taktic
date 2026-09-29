import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  requireAdmin,
  SHOWCASE_CARD_KIND_LABELS,
  SHOWCASE_CARD_STATUS_LABELS,
  type ShowcaseCardKind,
  type ShowcaseCardStatus,
  type ShowcasePriceTermsAcceptance,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { Pagination } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import { parsePage, type QueryParams } from '../../../lib/list-query';
import { formatCount } from '../../../lib/pagination';

const PATH = '/showcase/price-terms';

/** Rows per page; the API caps a page at 100. */
const PAGE_SIZE = 50;

/**
 * `ShowcasePriceTermsService.listForAdmin` (API-HARDENING-001): one page of
 * both tables merged newest first, the exact total for the filter, and every
 * version's count under the provider/card scope without the version filter.
 */
type PriceTermsPage = {
  acceptances: ShowcasePriceTermsAcceptance[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  versions: Array<{ termsVersion: string; count: number }>;
};

type PriceTermsPageProps = {
  searchParams: Promise<{ providerId?: string; cardId?: string; termsVersion?: string; page?: string }>;
};

/**
 * Vitrin metin onayları (#22). The design has no screen for it (class C), so it
 * is the shared list template (ADMIN-DESIGN-001 Faz 3C).
 *
 * Who agreed to which version of the price-responsibility text, and when.
 *
 * ## Read-only, and there is deliberately no button
 *
 * Not an omission to be filled in later. These rows are a record of consent,
 * and an operator who could add or remove one would be able to make the record
 * say what the platform wanted rather than what a business agreed to. There is
 * no API route behind such a button either, so the absence holds whatever a
 * future screen decides to render.
 *
 * ## Why every version is listed, not only the one in force
 *
 * The question asked here is historical. A provider whose run was sold under an
 * older version keeps that run to its own end date, and answering "what did
 * they agree to" for that placement means reading a superseded row. A list
 * narrowed to the current terms would hide exactly the history the table exists
 * to keep.
 *
 * ## What a row does not mean
 *
 * Not that the card is live, not that anything was bought, and not that a live
 * run is at risk when the version is superseded. Acceptance gates the *next*
 * purchase and nothing else — a placement already on the air runs to its end
 * under the terms it was sold under, which are snapshotted on the placement
 * itself rather than looked up from here.
 *
 * The version views come from the API's own per-version counts, taken without
 * the version filter, so choosing one never hides the others and the counters
 * do not depend on which page is open. The list itself is paged on the server:
 * every acceptance is reachable, however old.
 */

const SCREEN_INFO =
  'Hizmet bedeli sorumluluk metninin hangi sürümünü, hangi işletmenin, hangi kart ya da paket için ve kimin onayladığı. Kayıtlar yalnız eklenir: buradan onay oluşturulamaz, değiştirilemez ve silinemez. Onay yalnız bir sonraki vitrin satın almasını açar; yayındaki bir yerleşim, satıldığı andaki metinle sonuna kadar sürer.';

const COLUMNS: DataColumn[] = [
  { key: 'provider', label: 'İşletme' },
  { key: 'scope', label: 'Kapsam' },
  { key: 'card', label: 'Kart' },
  { key: 'version', label: 'Sürüm' },
  { key: 'acceptedBy', label: 'Onaylayan' },
  { key: 'acceptedAt', label: 'Onay zamanı' },
  { key: 'text', label: 'Onaylanan metin' },
];

export default async function ShowcasePriceTermsPage({ searchParams }: PriceTermsPageProps) {
  const { can } = await requireAdmin('SHOWCASE_TERMS_ACCEPTANCES_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenCards = can('SHOWCASE_CARDS_READ');

  const params = await searchParams;
  const providerId = (params.providerId ?? '').trim();
  const cardId = (params.cardId ?? '').trim();
  const termsVersion = (params.termsVersion ?? '').trim();
  const page = parsePage(params.page);

  const query = new URLSearchParams();
  if (providerId) query.set('providerId', providerId);
  if (cardId) query.set('cardId', cardId);
  if (termsVersion) query.set('termsVersion', termsVersion);
  query.set('page', String(page));
  query.set('pageSize', String(PAGE_SIZE));

  const response = await apiFetch<PriceTermsPage>(`/admin/showcase/price-terms-acceptances?${query.toString()}`);
  const { acceptances } = response;

  const counts = new Map(response.versions.map((entry) => [entry.termsVersion, entry.count]));
  const scopeTotal = response.versions.reduce((sum, entry) => sum + entry.count, 0);
  // The chosen version keeps its chip even when nothing in the scope names it.
  const versions = [...new Set([...counts.keys(), ...(termsVersion ? [termsVersion] : [])])].sort();
  const filters: QueryParams = { providerId, cardId, termsVersion };
  const pageParams: QueryParams = filters;
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: scopeTotal, testId: 'terms-view-all' },
    ...versions.map((value) => ({
      key: value,
      label: value,
      count: counts.get(value) ?? 0,
      testId: `terms-view-${value}`,
    })),
  ];

  const summary =
    scopeTotal === 0
      ? 'Henüz onay kaydı yok'
      : `${formatCount(scopeTotal)} onay · ${versions.length} metin sürümü${providerId || cardId ? ' · süzülmüş' : ''}`;

  return (
    <main className="showcase-price-terms-page">
      <PageHeader
        title="Vitrin metin onayları"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          can('SHOWCASE_PACKAGES_READ') ? (
            <Link className="btn btn-secondary" href="/showcase/packages">
              Vitrin paketleri
            </Link>
          ) : undefined
        }
      />

      <SavedViewTabs
        label="Metin sürümü"
        items={views}
        active={termsVersion}
        path={PATH}
        params={filters}
        param="termsVersion"
        testId="terms-views"
      />

      {providerId || cardId ? (
        <p className="detail-muted-note" data-testid="terms-scope-filter">
          {cardId ? 'Yalnız bir kartın onayları gösteriliyor.' : 'Yalnız bir işletmenin onayları gösteriliyor.'}{' '}
          <Link href={termsVersion ? `${PATH}?termsVersion=${encodeURIComponent(termsVersion)}` : PATH}>
            Tüm onaylar
          </Link>
        </p>
      ) : null}

      <div className="data-list-card">
        {acceptances.length === 0 ? (
          <EmptyState title="Onay yok" description="Bu filtreye uyan bir metin onayı bulunmuyor." />
        ) : (
          <DataTable caption="Vitrin metin onayları" columns={COLUMNS} minWidth={1180} testId="terms-table">
            {acceptances.map((row) => (
              <tr key={`${row.scope}-${row.id}`} data-testid="terms-row" data-scope={row.scope}>
                <td>
                  {canOpenProvider ? (
                    <Link className="cell-link" href={`/providers/${row.provider.id}`}>
                      {row.provider.businessName}
                    </Link>
                  ) : (
                    row.provider.businessName
                  )}
                </td>
                <td>{row.scope === 'PACKAGE' ? 'Paket' : 'Kart'}</td>
                <td>
                  {row.card ? (
                    <div className="cell-stack">
                      {canOpenCards ? (
                        <Link className="cell-link" href={`/showcase/cards?cardId=${encodeURIComponent(row.card.id)}`}>
                          <code>{row.card.id.slice(-6)}</code>
                        </Link>
                      ) : (
                        <code>{row.card.id.slice(-6)}</code>
                      )}
                      <span className="cell-muted">
                        {kindLabel(row.card.kind)} · {statusLabel(row.card.status)}
                      </span>
                    </div>
                  ) : (
                    // A package-first acceptance names no card: the business
                    // agreed once, for every card it goes on to buy for.
                    <span className="cell-muted">—</span>
                  )}
                </td>
                <td>
                  <code>{row.termsVersion}</code>
                </td>
                <td>
                  <div className="cell-stack">
                    <span>{row.acceptedByUser.name ?? '—'}</span>
                    <span className="cell-muted cell-break">{row.acceptedByUser.email ?? '—'}</span>
                  </div>
                </td>
                <td>{formatDateTime(row.acceptedAt)}</td>
                {/*
                  The sentence itself, from the row rather than from the running
                  application's constant. That is the whole reason the text is
                  snapshotted: an auditor asking what a business agreed to in
                  March must not have to check out an old commit to find out.
                */}
                <td style={{ maxWidth: 420 }}>
                  <span className="cell-muted" style={{ fontSize: 12 }}>
                    {row.termsTextSnapshot}
                  </span>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={pageParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="onay"
            summaryTestId="terms-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function kindLabel(kind: string): string {
  return SHOWCASE_CARD_KIND_LABELS[kind as ShowcaseCardKind] ?? kind;
}

function statusLabel(status: string): string {
  return SHOWCASE_CARD_STATUS_LABELS[status as ShowcaseCardStatus] ?? status;
}

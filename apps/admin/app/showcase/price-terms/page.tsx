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
import { WholeListFooter } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import type { QueryParams } from '../../../lib/list-query';

const PATH = '/showcase/price-terms';

/**
 * `ShowcasePriceTermsService.listForAdmin` reads the newest 200 card-bound and
 * the newest 200 package-bound acceptances; either table reaching its cap is
 * the point where this list stops being the whole ledger.
 */
const API_TABLE_CAP = 200;

type PriceTermsPageProps = {
  searchParams: Promise<{ providerId?: string; cardId?: string; termsVersion?: string }>;
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
 * The version views are read from the list without the version filter, so
 * choosing one no longer hides the others (it did before this slice: the
 * chips were derived from the already-filtered rows).
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

  const scopeQuery = new URLSearchParams();
  if (providerId) scopeQuery.set('providerId', providerId);
  if (cardId) scopeQuery.set('cardId', cardId);

  // The version chips come from a read without the version filter, so they do
  // not shrink to the chosen version. The rows under a chosen version are the
  // API's own filtered answer, not a cut of the first read: each table stops
  // at 200 rows, and the newest 200 need not contain an older version's rows.
  const read = (query: URLSearchParams) =>
    apiFetch<{ acceptances: ShowcasePriceTermsAcceptance[] }>(
      `/admin/showcase/price-terms-acceptances${query.toString() ? `?${query.toString()}` : ''}`,
    ).then((answer) => answer.acceptances);
  const versionQuery = new URLSearchParams(scopeQuery);
  if (termsVersion) versionQuery.set('termsVersion', termsVersion);
  const [all, acceptances] = await Promise.all([
    read(scopeQuery),
    termsVersion ? read(versionQuery) : null,
  ]).then(([unfiltered, filtered]) => [unfiltered, filtered ?? unfiltered] as const);

  const reachedCap = (rows: ShowcasePriceTermsAcceptance[]) =>
    rows.filter((row) => row.scope === 'CARD').length >= API_TABLE_CAP ||
    rows.filter((row) => row.scope === 'PACKAGE').length >= API_TABLE_CAP;
  // Counters only while the unfiltered read is the whole ledger.
  const exactCounts = !reachedCap(all);
  // The chosen version keeps its chip even when it is older than the newest rows.
  const versions = [...new Set([...all.map((row) => row.termsVersion), ...(termsVersion ? [termsVersion] : [])])].sort();
  const filters: QueryParams = { providerId, cardId, termsVersion };
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: exactCounts ? all.length : null, testId: 'terms-view-all' },
    ...versions.map((value) => ({
      key: value,
      label: value,
      count: exactCounts ? all.filter((row) => row.termsVersion === value).length : null,
      testId: `terms-view-${value}`,
    })),
  ];

  const capped = reachedCap(acceptances);

  const summary =
    all.length === 0
      ? 'Henüz onay kaydı yok'
      : `${exactCounts ? all.length : `En yeni ${all.length}`} onay · ${versions.length} metin sürümü${
          providerId || cardId ? ' · süzülmüş' : ''
        }`;

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
        {acceptances.length > 0 ? (
          <WholeListFooter
            count={acceptances.length}
            noun="onay"
            cap={capped ? acceptances.length : undefined}
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

import Link from 'next/link';
import {
  apiFetch,
  formatDateTime,
  formatPrice,
  requireAdmin,
  showcasePlacementBadgeClass,
  SHOWCASE_PLACEMENT_STATUS_LABELS,
  SHOWCASE_SUSPEND_REASON_LABELS,
  type ShowcasePlacement,
  type ShowcasePlacementStatus,
} from '../../../lib/api';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { WholeListFooter } from '../../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../../components/tabs';
import type { QueryParams } from '../../../lib/list-query';

const STATUSES: ShowcasePlacementStatus[] = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED',
];

const PATH = '/showcase/placements';

type PlacementsPageProps = {
  searchParams: Promise<{ status?: string; providerId?: string }>;
};

/**
 * Yayında olan kartlar (#23), design `list:placements` (paket 2
 * `32-vitrin-yayinda-olan-kartlar`, ADMIN-DESIGN-001 Faz 3C).
 *
 * Every paid vitrin run in the system.
 *
 * Read-only here; the decisions live on one run's own screen, for the reason
 * the card list defers to a version's screen — suspending a run is a judgement
 * about a particular business's advertising, and a row in a list is not where
 * that gets made.
 *
 * The API answers with every run (no page, no cap), so this screen asks once
 * for all of them — narrowed only by `providerId`, which it passes through —
 * and splits them by status itself. That is what makes the view counters and
 * the summary exact rather than a count of whatever page is on screen; the
 * rows shown under a view are the ones `?status=` returned before.
 *
 * Not drawn from the design: its Ara and Tarih filters (the API takes neither),
 * and "Durdurulmuşları göster" as a button — the "Yayında değil" view is that
 * list.
 */

/**
 * The design's ⓘ, corrected. Cancelling does not "open a refund
 * conversation": it ends the run for good and flags the purchase for a person
 * (admin-showcase-placements.service.ts), and only some holds stop the clock.
 */
const SCREEN_INFO =
  'Satın alınmış vitrin süreleri. Yerleşimi operatör kararıyla durdurursanız gün sayacı da durur: kart yeniden yayına alındığında durduğu süre bitiş tarihine eklenir. Kategori kapanması gibi sistem engelleri de sayacı durdurur; hizmet verenin kendi kartını arşivlemesi veya onayını kaybetmesi durdurmaz. İptal geri alınamaz: yerleşim sonlanır, para iadesi otomatik yapılmaz, ilgili satın alma manuel inceleme için işaretlenir. Kararlar yerleşimin kendi ekranında verilir.';

const COLUMNS: DataColumn[] = [
  { key: 'card', label: 'Kart' },
  { key: 'provider', label: 'İşletme' },
  { key: 'package', label: 'Paket' },
  { key: 'window', label: 'Yayın süresi' },
  { key: 'leads', label: 'Gelen talep', align: 'end' },
  { key: 'status', label: 'Durum' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function ShowcasePlacementsPage({ searchParams }: PlacementsPageProps) {
  const { can } = await requireAdmin('SHOWCASE_PLACEMENTS_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');

  const { status, providerId } = await searchParams;
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;
  const provider = (providerId ?? '').trim();

  const query = new URLSearchParams();
  if (provider) query.set('providerId', provider);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const { placements: all } = await apiFetch<{ placements: ShowcasePlacement[] }>(
    `/admin/showcase/placements${suffix}`,
  );

  const countOf = (value: ShowcasePlacementStatus) => all.filter((placement) => placement.status === value).length;
  const placements = selected ? all.filter((placement) => placement.status === selected) : all;

  const params: QueryParams = { status: selected ?? '', providerId: provider };
  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: all.length, testId: 'placement-view-all' },
    ...STATUSES.map((value) => ({
      key: value,
      label: SHOWCASE_PLACEMENT_STATUS_LABELS[value],
      count: countOf(value),
      testId: `placement-view-${value.toLowerCase()}`,
    })),
  ];

  const active = countOf('ACTIVE');
  const suspended = countOf('SUSPENDED');
  const summary =
    all.length === 0
      ? 'Henüz satın alınmış bir vitrin süresi yok'
      : `${active} kart yayında · ${suspended} tanesi durdurulmuş${provider ? ' · tek işletme' : ''}`;

  return (
    <main className="showcase-placements-page">
      <PageHeader title="Yayında olan kartlar" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Yerleşim durumu"
        items={views}
        active={selected ?? ''}
        path={PATH}
        params={params}
        param="status"
        testId="placement-views"
      />

      {provider ? (
        <p className="detail-muted-note" data-testid="placement-provider-filter">
          Yalnız bir işletmenin yerleşimleri gösteriliyor.{' '}
          <Link href={selected ? `${PATH}?status=${selected}` : PATH}>Tüm işletmeler</Link>
        </p>
      ) : null}

      <div className="data-list-card">
        {placements.length === 0 ? (
          <EmptyState
            title="Yerleşim yok"
            description={
              selected
                ? 'Bu durumda bir vitrin yerleşimi bulunmuyor.'
                : 'Bir hizmet veren vitrin paketi satın alıp kartı onaylandığında burada listelenir.'
            }
          />
        ) : (
          <DataTable caption="Vitrin yerleşimleri" columns={COLUMNS} minWidth={1040} testId="placement-table">
            {placements.map((placement) => (
              <tr key={placement.id} data-testid="placement-row" data-status={placement.status}>
                <td>
                  <div className="cell-stack">
                    <Link className="cell-link" href={`/showcase/placements/${placement.id}`}>
                      <strong className="cell-break" id={`placement-title-${placement.id}`}>
                        {placement.version.title}
                      </strong>
                    </Link>
                    <span className="cell-muted">{placement.category.name}</span>
                  </div>
                </td>
                <td>
                  {placement.provider && canOpenProvider ? (
                    <Link className="cell-link" href={`/providers/${placement.provider.id}`}>
                      {placement.provider.businessName}
                    </Link>
                  ) : (
                    (placement.provider?.businessName ?? '—')
                  )}
                </td>
                <td>
                  <div className="cell-stack">
                    <span>{placement.packageName}</span>
                    <span className="cell-muted">{formatPrice(placement.priceAmount, placement.currency)}</span>
                  </div>
                </td>
                <td>
                  <div className="cell-stack">
                    <span>
                      {formatDateTime(placement.startAt)} → {formatDateTime(placement.endAt)}
                    </span>
                    <span className="cell-muted">{windowNote(placement)}</span>
                  </div>
                </td>
                <td className="is-num">{placement.leadCount}</td>
                <td>
                  <div className="cell-stack">
                    <span className={showcasePlacementBadgeClass(placement.status)}>
                      {SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}
                    </span>
                    {placement.suspendReason ? (
                      <span className="cell-muted">{SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]}</span>
                    ) : null}
                  </div>
                </td>
                <td className="col-actions">
                  <Link
                    className="btn btn-secondary btn-sm"
                    href={`/showcase/placements/${placement.id}`}
                    aria-describedby={`placement-title-${placement.id}`}
                  >
                    Aç
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {placements.length > 0 ? (
          <WholeListFooter count={placements.length} noun="yerleşim" summaryTestId="placement-count" />
        ) : null}
      </div>
    </main>
  );
}

/**
 * The line under the dates: what has happened to the window, from the run's
 * own fields. No "N gün kaldı" countdown — the page would be the only place
 * deciding what "today" is, and a cached render would state a stale number.
 */
function windowNote(placement: ShowcasePlacement): string {
  const extended = placement.extendedDays > 0 ? ` · durdurmalar nedeniyle +${placement.extendedDays} gün` : '';
  switch (placement.status) {
    case 'SUSPENDED':
      return `${placement.suspendedAt ? `Durduruldu: ${formatDateTime(placement.suspendedAt)}` : 'Durduruldu'}${extended}`;
    case 'EXPIRED':
      return `Tamamlandı${extended}`;
    case 'CANCELLED':
      return placement.cancelledAt ? `İptal: ${formatDateTime(placement.cancelledAt)}` : 'İptal edildi';
    case 'PENDING_ACTIVATION':
      return 'Yayına giriyor';
    default:
      return `${placement.durationDays} günlük yayın${extended}`;
  }
}

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
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';

const STATUSES: ShowcasePlacementStatus[] = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED',
];

type PlacementsPageProps = {
  searchParams: Promise<{ status?: string; providerId?: string }>;
};

/**
 * Every paid vitrin run in the system.
 *
 * Read-only here; the decisions live on one run's own screen, for the reason
 * the card list defers to a version's screen — suspending a run is a judgement
 * about a particular business's advertising, and a row in a list is not where
 * that gets made.
 *
 * The column an operator most often needs is the last one: whether a run that is
 * off the air is costing its owner days, or the platform is paying them back.
 * It is derived from the suspension reason and not from anything the operator
 * can set, which is the whole of the clock rule.
 */
export default async function ShowcasePlacementsPage({ searchParams }: PlacementsPageProps) {
  await requireAdmin();

  const { status, providerId } = await searchParams;
  const selected = STATUSES.find((candidate) => candidate === status) ?? null;

  const query = new URLSearchParams();
  if (selected) query.set('status', selected);
  if (providerId) query.set('providerId', providerId);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const { placements } = await apiFetch<{ placements: ShowcasePlacement[] }>(
    `/admin/showcase/placements${suffix}`,
  );

  return (
    <>
      <PageHeader
        title="Vitrin Yerleşimleri"
        subtitle="Satın alınmış vitrin süreleri, yayın durumları ve durdurma geçmişleri."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Vitrin Yerleşimleri' }]}
      />

      <SectionCard
        title="Yerleşimler"
        subtitle={`${placements.length} yerleşim listeleniyor.`}
        actions={
          <span className="inline-actions">
            <Link
              className={`btn btn-sm ${selected ? 'btn-secondary' : 'btn-primary'}`}
              href="/showcase/placements"
            >
              Tümü
            </Link>
            {STATUSES.map((candidate) => (
              <Link
                key={candidate}
                className={`btn btn-sm ${selected === candidate ? 'btn-primary' : 'btn-secondary'}`}
                href={`/showcase/placements?status=${candidate}`}
              >
                {SHOWCASE_PLACEMENT_STATUS_LABELS[candidate]}
              </Link>
            ))}
          </span>
        }
        padded={false}
      >
        {placements.length === 0 ? (
          <EmptyState
            title="Yerleşim yok"
            description="Bu filtreye uyan bir vitrin yerleşimi bulunmuyor."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kart</th>
                  <th>İşletme</th>
                  <th>Paket</th>
                  <th>Süre</th>
                  <th>Talep</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {placements.map((placement) => (
                  <tr key={placement.id}>
                    <td>
                      <Link href={`/showcase/placements/${placement.id}`}>
                        {placement.version.title}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {placement.category.name}
                      </div>
                    </td>
                    <td>{placement.provider?.businessName ?? '—'}</td>
                    <td>
                      {placement.packageName}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {formatPrice(placement.priceAmount, placement.currency)}
                      </div>
                    </td>
                    <td>
                      {formatDateTime(placement.startAt)}
                      <div className="muted" style={{ fontSize: 12 }}>
                        → {formatDateTime(placement.endAt)}
                        {placement.extendedDays > 0 ? ` (+${placement.extendedDays} gün)` : ''}
                      </div>
                    </td>
                    <td>{placement.leadCount}</td>
                    <td>
                      <span className={showcasePlacementBadgeClass(placement.status)}>
                        {SHOWCASE_PLACEMENT_STATUS_LABELS[placement.status]}
                      </span>
                      {placement.suspendReason ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {SHOWCASE_SUSPEND_REASON_LABELS[placement.suspendReason]}
                        </div>
                      ) : null}
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

import Link from 'next/link';
import { apiFetch, AdminOfferPackage, formatDateTime, formatPrice, requireAdmin } from '../../lib/api';
import { buildHref } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { WholeListFooter } from '../../components/pagination';
import { moveCreditPackageAction, updateCreditPackageStatusAction } from './actions';
import {
  CREDIT_PACKAGES_SCREEN_INFO,
  PackageOrderCell,
  PackageStatusForm,
  packageAllowance,
  packageTypeLabel,
} from './credit-package-cells';

/**
 * Kredi paketleri (#41), design `list:creditPackages` (paket 2
 * `37-kredi-paketleri`, ADMIN-DESIGN-001 Faz 3F).
 *
 * The design's list template with every control the screen had: Sıra ↑/↓
 * (CREDIT_PACKAGES_WRITE), Aktifleştir / Pasifleştir on the row
 * (CREDIT_PACKAGES_STATUS), all three package types with their scope, period
 * and daily cap, and the currency column (K7). "Aç" opens the package; the
 * form there is the one edit surface.
 *
 * Not drawn: the design's "en çok satan" (it would need the purchase list,
 * a separate read behind PACKAGE_PURCHASES_READ, for a screen that is about
 * the catalogue), its Tarih filter (a package has no date the list filters on)
 * and Önceki / Sonraki (the API returns every package).
 */

type StatusFilter = 'all' | 'active' | 'inactive';

const PATH = '/credit-packages';

type AdminCreditPackagesPageProps = {
  searchParams: Promise<{
    q?: string;
    status?: string;
    error?: string;
    ok?: string;
    partial?: string;
  }>;
};

const OK_MESSAGES: Record<string, string> = {
  created: 'Paket oluşturuldu.',
  saved: 'Paket güncellendi.',
  activated: 'Paket aktifleştirildi.',
  deactivated: 'Paket pasifleştirildi.',
};

function normalizeStatusFilter(value: string | undefined): StatusFilter {
  if (value === 'active' || value === 'inactive') return value;
  return 'all';
}

function canonicalSort(packages: AdminOfferPackage[]) {
  return [...packages].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'tr-TR') || a.id.localeCompare(b.id),
  );
}

const COLUMNS: DataColumn[] = [
  { key: 'order', label: 'Sıra', align: 'end' },
  { key: 'package', label: 'Paket' },
  { key: 'type', label: 'Tür' },
  { key: 'credits', label: 'Kredi / kota', align: 'end' },
  { key: 'price', label: 'Fiyat', align: 'end' },
  { key: 'currency', label: 'Para birimi' },
  { key: 'status', label: 'Durum' },
  { key: 'updated', label: 'Güncellenme' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

export default async function AdminCreditPackagesPage({ searchParams }: AdminCreditPackagesPageProps) {
  const { can } = await requireAdmin('CREDIT_PACKAGES_READ');
  // `/credit-packages/new` gates on CREDIT_PACKAGES_READ + WRITE; reordering is a
  // PATCH (WRITE); the status toggle is its own permission.
  const canWrite = can('CREDIT_PACKAGES_WRITE');
  const canChangeStatus = can('CREDIT_PACKAGES_STATUS');
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatusFilter(params.status);
  const errorMessage = (params.error ?? '').trim();
  const okKey = (params.ok ?? '').trim();
  const partialFailure = params.partial === '1';
  const okMessage = okKey ? (OK_MESSAGES[okKey] ?? null) : null;

  // The admin listing: every package of every type, with its category scope.
  // The public `/credit-packages` route deliberately returns only the one-time
  // packages, because it answers unauthenticated callers.
  const packages = await apiFetch<AdminOfferPackage[]>('/admin/offer-packages');

  const canonical = canonicalSort(packages);
  const positionById = new Map<string, number>();
  canonical.forEach((pkg, index) => positionById.set(pkg.id, index));

  const normalizedQuery = query.toLocaleLowerCase('tr-TR');
  const filtered = canonical.filter((pkg) => {
    if (status === 'active' && !pkg.isActive) return false;
    if (status === 'inactive' && pkg.isActive) return false;
    if (!normalizedQuery) return true;
    const haystack = `${pkg.name} ${pkg.slug}`.toLocaleLowerCase('tr-TR');
    return haystack.includes(normalizedQuery);
  });

  const totalActive = packages.filter((pkg) => pkg.isActive).length;
  const totalInactive = packages.length - totalActive;
  const hasFilters = query.length > 0 || status !== 'all';
  const filterParams = { q: query, status: status === 'all' ? '' : status };

  const newPackageLink = canWrite ? (
    <Link className="btn btn-primary" href="/credit-packages/new" data-testid="credit-package-new-link">
      Yeni paket ekle
    </Link>
  ) : undefined;

  return (
    <main className="catalog-page catalog-list-page">
      <PageHeader
        title="Kredi paketleri"
        subtitle={
          packages.length === 0
            ? 'Henüz paket yok'
            : `${formatCount(totalActive)} paket satışta · ${formatCount(totalInactive)} pasif`
        }
        info={CREDIT_PACKAGES_SCREEN_INFO}
        actions={newPackageLink}
      />

      {errorMessage ? (
        <div className="notice notice-error detail-notice" role="alert">
          {errorMessage}
          {partialFailure ? <> Sıra takasının ikinci adımı tamamlanmadı; listeyi yenileyip tekrar deneyin.</> : null}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success detail-notice" role="status">
          {okMessage}
        </div>
      ) : null}

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Kredi paketi filtreleri"
        testId="credit-package-filters"
      >
        <FilterField label="Ara" htmlFor="package-search" wide>
          <input
            id="package-search"
            name="q"
            type="search"
            placeholder="Paket adı veya kısa ad"
            defaultValue={query}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Durum" htmlFor="package-status">
          <select id="package-status" name="status" defaultValue={status}>
            <option value="all">Tümü</option>
            <option value="active">Aktif</option>
            <option value="inactive">Pasif</option>
          </select>
        </FilterField>
      </FilterBar>

      <section className="data-list-card" aria-labelledby="credit-package-list-title">
        <header className="data-list-card-head">
          <h2 id="credit-package-list-title">Paket listesi</h2>
          <p className="cell-muted">
            {canWrite
              ? 'Sıra oklarıyla bir paketi komşusuyla yer değiştirirsiniz; sıra filtreden bağımsız, tüm paketler üzerindedir.'
              : 'Paketler hizmet verene bu sırayla listelenir.'}
          </p>
        </header>

        {filtered.length === 0 ? (
          packages.length === 0 ? (
            <EmptyState
              title="Henüz paket yok."
              description="İlk paketinizi oluşturduğunuzda burada listelenecek."
              action={newPackageLink}
            />
          ) : (
            <EmptyState
              title="Filtrelere uygun paket bulunamadı."
              description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
              action={
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Kredi paketleri" columns={COLUMNS} minWidth={1060} testId="credit-package-table">
            {filtered.map((pkg) => {
              const position = positionById.get(pkg.id) ?? 0;
              return (
                <tr key={pkg.id} data-testid="credit-package-row" data-package-id={pkg.id}>
                  <td className="is-num">
                    <PackageOrderCell
                      pkg={pkg}
                      canWrite={canWrite}
                      isFirst={position === 0}
                      isLast={position === canonical.length - 1}
                      moveAction={moveCreditPackageAction}
                    />
                  </td>
                  <td>
                    <div className="cell-stack">
                      <Link
                        className="cell-link cell-break"
                        href={`/credit-packages/${pkg.id}`}
                        id={`credit-package-name-${pkg.id}`}
                      >
                        <strong>{pkg.name}</strong>
                      </Link>
                      <code className="cell-muted cell-break">{pkg.slug}</code>
                    </div>
                  </td>
                  <td>
                    <div className="cell-stack">
                      <span>{packageTypeLabel(pkg.type)}</span>
                      {pkg.type === 'CATEGORY_UNLIMITED' ? (
                        <span className="cell-muted cell-break">
                          {pkg.scopeCategories.length > 0
                            ? pkg.scopeCategories.map((scope) => scope.category.name).join(', ')
                            : 'Kapsam tanımsız'}
                        </span>
                      ) : null}
                      {pkg.periodDays ? <span className="cell-muted">{pkg.periodDays} gün geçerli</span> : null}
                    </div>
                  </td>
                  <td className="is-num">
                    <strong>{packageAllowance(pkg)}</strong>
                    {pkg.type === 'CATEGORY_UNLIMITED' && pkg.dailyOfferLimit ? (
                      <div className="cell-muted">günlük {pkg.dailyOfferLimit}</div>
                    ) : null}
                  </td>
                  <td className="is-num">
                    <strong>{formatPrice(pkg.priceAmount, pkg.currency)}</strong>
                  </td>
                  <td>{pkg.currency}</td>
                  <td>
                    <span className={pkg.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                      {pkg.isActive ? 'Aktif' : 'Pasif'}
                    </span>
                  </td>
                  <td className="cell-nowrap">{formatDateTime(pkg.updatedAt)}</td>
                  <td className="col-actions">
                    <div className="inline-actions">
                      <Link
                        className="btn btn-secondary btn-sm"
                        href={`/credit-packages/${pkg.id}`}
                        aria-describedby={`credit-package-name-${pkg.id}`}
                      >
                        Aç
                      </Link>
                      {canChangeStatus ? (
                        <PackageStatusForm pkg={pkg} redirectTo={PATH} action={updateCreditPackageStatusAction} />
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
        {filtered.length > 0 ? (
          <WholeListFooter
            count={filtered.length}
            total={packages.length}
            noun="paket"
            summaryTestId="credit-package-count"
          />
        ) : null}
      </section>
    </main>
  );
}

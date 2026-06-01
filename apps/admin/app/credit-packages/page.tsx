import Link from 'next/link';
import {
  apiFetch,
  OfferCreditPackage,
  formatDateTime,
  formatPrice,
  requireAdmin,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';
import { moveCreditPackageAction, updateCreditPackageStatusAction } from './actions';

type StatusFilter = 'all' | 'active' | 'inactive';

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

function canonicalSort(packages: OfferCreditPackage[]) {
  return [...packages].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, 'tr-TR') ||
      a.id.localeCompare(b.id),
  );
}

export default async function AdminCreditPackagesPage({
  searchParams,
}: AdminCreditPackagesPageProps) {
  await requireAdmin();
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatusFilter(params.status);
  const errorMessage = (params.error ?? '').trim();
  const okKey = (params.ok ?? '').trim();
  const partialFailure = params.partial === '1';
  const okMessage = okKey ? OK_MESSAGES[okKey] ?? null : null;

  const packages = await apiFetch<OfferCreditPackage[]>(
    '/credit-packages?includeInactive=true',
  );

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

  return (
    <main className="credit-packages-page">
      <PageHeader
        title="Kredi Paketleri"
        subtitle="Hizmet verenlere satılan paketleri yönetin. Pasifleştirilen paketler yeni satışa kapanır, mevcut satın almaları etkilemez."
        actions={
          <Link className="btn btn-primary btn-sm" href="/credit-packages/new">
            Yeni Paket
          </Link>
        }
      />

      {errorMessage ? (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
          {errorMessage}
          {partialFailure ? (
            <> Sıra takasının ikinci adımı tamamlanmadı; listeyi yenileyip tekrar deneyin.</>
          ) : null}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }}>
          {okMessage}
        </div>
      ) : null}

      <form className="admin-toolbar" method="get" action="/credit-packages">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="package-search">Ara</label>
          <input
            id="package-search"
            name="q"
            type="search"
            placeholder="Paket adı veya slug"
            defaultValue={query}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="package-status">Durum</label>
          <select id="package-status" name="status" defaultValue={status}>
            <option value="all">Tümü</option>
            <option value="active">Aktif</option>
            <option value="inactive">Pasif</option>
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {filtered.length} / {packages.length} kayıt · {totalActive} aktif · {totalInactive} pasif
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/credit-packages">
              Sıfırla
            </Link>
          ) : null}
        </div>
      </form>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Paket listesi</h2>
            <p className="table-header-sub">
              Sıra mikro butonlarıyla yer değiştirebilir. Düzenlemek için paket adına tıklayın.
            </p>
          </div>
          <span className="admin-toolbar-summary">{filtered.length} kayıt</span>
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: 18 }}>
            {packages.length === 0 ? (
              <EmptyState
                title="Henüz paket yok."
                description="İlk paketinizi oluşturduğunuzda burada listelenecek."
                action={
                  <Link className="btn btn-primary btn-sm" href="/credit-packages/new">
                    Yeni Paket
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="Filtrelere uygun paket bulunamadı."
                description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
                action={
                  <Link className="btn btn-secondary btn-sm" href="/credit-packages">
                    Filtreleri temizle
                  </Link>
                }
              />
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-num">Sıra</th>
                  <th>Paket</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num">Fiyat</th>
                  <th>Para birimi</th>
                  <th>Durum</th>
                  <th>Güncellenme</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((pkg) => {
                  const position = positionById.get(pkg.id) ?? 0;
                  const isFirst = position === 0;
                  const isLast = position === canonical.length - 1;
                  return (
                    <tr key={pkg.id}>
                      <td className="col-num">
                        <div
                          className="inline-actions"
                          style={{ justifyContent: 'flex-end', gap: 4, flexWrap: 'nowrap' }}
                        >
                          <form action={moveCreditPackageAction}>
                            <input type="hidden" name="id" value={pkg.id} />
                            <input type="hidden" name="direction" value="up" />
                            <button
                              type="submit"
                              className="btn btn-ghost btn-sm"
                              aria-label="Yukarı taşı"
                              title="Yukarı taşı"
                              disabled={isFirst}
                            >
                              ↑
                            </button>
                          </form>
                          <form action={moveCreditPackageAction}>
                            <input type="hidden" name="id" value={pkg.id} />
                            <input type="hidden" name="direction" value="down" />
                            <button
                              type="submit"
                              className="btn btn-ghost btn-sm"
                              aria-label="Aşağı taşı"
                              title="Aşağı taşı"
                              disabled={isLast}
                            >
                              ↓
                            </button>
                          </form>
                          <span
                            className="cell-muted"
                            style={{ minWidth: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                          >
                            {pkg.sortOrder}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <Link className="cell-link" href={`/credit-packages/${pkg.id}`}>
                            <strong>{pkg.name}</strong>
                          </Link>
                          <span className="cell-muted" style={{ fontSize: 12 }}>
                            <code>{pkg.slug}</code>
                          </span>
                        </div>
                      </td>
                      <td className="col-num">
                        <strong>{pkg.creditAmount}</strong>
                      </td>
                      <td className="col-num">{formatPrice(pkg.priceAmount, pkg.currency)}</td>
                      <td>{pkg.currency}</td>
                      <td>
                        <span className={pkg.isActive ? 'badge badge-good' : 'badge badge-muted'}>
                          {pkg.isActive ? 'Aktif' : 'Pasif'}
                        </span>
                      </td>
                      <td>{formatDateTime(pkg.updatedAt)}</td>
                      <td className="col-actions">
                        <div className="inline-actions">
                          <Link
                            className="btn btn-secondary btn-sm"
                            href={`/credit-packages/${pkg.id}`}
                          >
                            Düzenle
                          </Link>
                          <form action={updateCreditPackageStatusAction}>
                            <input type="hidden" name="id" value={pkg.id} />
                            <input type="hidden" name="isActive" value={String(!pkg.isActive)} />
                            <input type="hidden" name="redirectTo" value="/credit-packages" />
                            <button
                              className={
                                pkg.isActive ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'
                              }
                              type="submit"
                            >
                              {pkg.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

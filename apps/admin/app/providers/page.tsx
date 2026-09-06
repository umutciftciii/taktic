import { serviceAreaLabel } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  Category,
  ProviderProfile,
  ProviderStatus,
  formatDateTime,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import { PageHeader } from '../../components/page-header';
import { EmptyState } from '../../components/empty-state';

type RawSearchParams = {
  q?: string;
  status?: string;
  city?: string;
  category?: string;
  ownership?: string;
};

type AdminProvidersPageProps = {
  searchParams: Promise<RawSearchParams>;
};

type StatusFilter = ProviderStatus | 'all';

const statusFilters: Array<{ label: string; value: StatusFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Taslak', value: 'DRAFT' },
  { label: 'İnceleme bekliyor', value: 'PENDING_REVIEW' },
  { label: 'Onaylandı', value: 'APPROVED' },
  { label: 'Reddedildi', value: 'REJECTED' },
  { label: 'Askıya alındı', value: 'SUSPENDED' },
];

function normalizeStatus(value: string | undefined): StatusFilter {
  const upper = value?.toUpperCase();
  if (
    upper === 'DRAFT' ||
    upper === 'PENDING_REVIEW' ||
    upper === 'APPROVED' ||
    upper === 'REJECTED' ||
    upper === 'SUSPENDED'
  ) {
    return upper;
  }
  return 'all';
}

type OwnershipFilter = 'all' | 'unclaimed' | 'claimed';

/**
 * "Sahipsiz" is the applications queue: nobody can sign in and manage these,
 * and until somebody does they are administrable only. It is the one cut of
 * this list the claim flow made worth having.
 */
const ownershipFilters: Array<{ label: string; value: OwnershipFilter }> = [
  { label: 'Tümü', value: 'all' },
  { label: 'Sahipsiz', value: 'unclaimed' },
  { label: 'Hesaba bağlı', value: 'claimed' },
];

function normalizeOwnership(value: string | undefined): OwnershipFilter {
  const lower = value?.toLowerCase();
  return lower === 'unclaimed' || lower === 'claimed' ? lower : 'all';
}

function toLower(value: string | null | undefined) {
  return (value ?? '').toLocaleLowerCase('tr-TR');
}

export default async function AdminProvidersPage({ searchParams }: AdminProvidersPageProps) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatus(params.status);
  const cityFilter = (params.city ?? '').trim();
  const categorySlug = (params.category ?? '').trim();
  const ownership = normalizeOwnership(params.ownership);

  const categories = await apiFetch<Category[]>('/categories?includeInactive=true').catch(
    () => [] as Category[],
  );

  const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));
  const categoryId = categorySlug ? categoryIdBySlug.get(categorySlug) ?? '' : '';

  const apiQuery = new URLSearchParams();
  if (status !== 'all') apiQuery.set('status', status);
  if (cityFilter) apiQuery.set('city', cityFilter);
  if (categoryId) apiQuery.set('categoryId', categoryId);
  if (ownership !== 'all') apiQuery.set('ownership', ownership);
  const queryString = apiQuery.toString();
  const providersPath = queryString ? `/providers?${queryString}` : '/providers';

  const providers = await apiFetch<ProviderProfile[]>(providersPath);

  const normalizedQuery = toLower(query);

  const filtered = providers.filter((provider) => {
    if (!normalizedQuery) return true;
    const haystack = [
      provider.businessName,
      provider.contactName,
      provider.phone,
      provider.email,
      provider.city,
      provider.district,
    ]
      .map(toLower)
      .join(' ');
    return haystack.includes(normalizedQuery);
  });

  const sortedCategories = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR'),
  );

  const hasFilters =
    query.length > 0 ||
    status !== 'all' ||
    cityFilter.length > 0 ||
    categorySlug.length > 0 ||
    ownership !== 'all';

  return (
    <main className="providers-page">
      <PageHeader
        title="Hizmet Verenler"
        subtitle="Başvuruları inceleyin, aktif hizmet verenleri ve operasyonel sinyalleri yönetin."
      />

      <form className="admin-toolbar" method="get" action="/providers">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="provider-search">Ara</label>
          <input
            id="provider-search"
            name="q"
            type="search"
            placeholder="İşletme, yetkili, telefon, e-posta, şehir"
            defaultValue={query}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-status">Durum</label>
          <select id="provider-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-city">Hizmet ili</label>
          <input
            id="provider-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-category">Kategori</label>
          <select id="provider-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="provider-ownership">Sahiplik</label>
          <select id="provider-ownership" name="ownership" defaultValue={ownership}>
            {ownershipFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {filtered.length} / {providers.length} kayıt
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/providers">
              Sıfırla
            </Link>
          ) : null}
        </div>
      </form>

      <div className="table-card">
        <div className="table-header">
          <div className="table-header-text">
            <h2>Hizmet veren listesi</h2>
            <p className="table-header-sub">Filtreler URL üzerinden paylaşılabilir.</p>
          </div>
          <span className="admin-toolbar-summary">{filtered.length} kayıt</span>
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: 18 }}>
            {providers.length === 0 ? (
              <EmptyState
                title="Henüz hizmet veren yok."
                description="Yeni başvurular geldikçe burada listelenecek."
              />
            ) : (
              <EmptyState
                title="Filtrelere uygun hizmet veren bulunamadı."
                description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
                action={
                  <Link className="btn btn-secondary btn-sm" href="/providers">
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
                  <th>Oluşturulma</th>
                  <th>İşletme</th>
                  <th>İletişim</th>
                  <th>Konum ve bölgeler</th>
                  <th>Kategoriler</th>
                  <th>Durum</th>
                  <th>Sahiplik</th>
                  <th className="col-num">Kredi</th>
                  <th className="col-num" title="Müşteri tarafından hâlâ değerlendirilebilir teklifler">Açık teklif</th>
                  <th className="col-num">Paket</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((provider) => {
                  const providerCategories = provider.serviceCategories ?? [];
                  const visibleCategories = providerCategories.slice(0, 2);
                  const extraCategories = providerCategories.length - visibleCategories.length;
                  const creditBalance = provider.creditBalance ?? 0;
                  const activeOffers = provider.activeOffersCount ?? 0;
                  const packages = provider.packagePurchasesCount ?? 0;
                  return (
                    <tr key={provider.id}>
                      <td>{formatDateTime(provider.createdAt)}</td>
                      <td>
                        <div className="cell-stack">
                          <strong>{provider.businessName}</strong>
                          <span className="cell-muted">{provider.contactName}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          {provider.phone ? (
                            <a className="cell-link" href={`tel:${provider.phone}`}>
                              {provider.phone}
                            </a>
                          ) : null}
                          {provider.email ? (
                            <a className="cell-link cell-muted" href={`mailto:${provider.email}`}>
                              {provider.email}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          {/*
                            Two different facts, and the second is the one that
                            decides anything: the location the profile has
                            carried since before coverage was a list, then the
                            areas matching actually reads. The filter above
                            selects on the areas, so a row surfaced by it has to
                            show why.
                          */}
                          <span>
                            {provider.city}/{provider.district}
                          </span>
                          <span className="cell-muted">
                            {provider.serviceAreas.length === 0
                              ? 'Bölge tanımlı değil'
                              : provider.serviceAreas.map(serviceAreaLabel).join(' · ')}
                          </span>
                          {provider.addressNote ? (
                            <span className="cell-muted">{provider.addressNote}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 4 }}>
                          {visibleCategories.length === 0 ? (
                            <span className="cell-muted">-</span>
                          ) : (
                            visibleCategories.map((item) => (
                              <span key={item.id} className="badge badge-muted">
                                {item.category.name}
                              </span>
                            ))
                          )}
                          {extraCategories > 0 ? (
                            <span className="cell-muted">+{extraCategories}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <span className={statusBadgeClass(provider.status)}>
                          {statusLabel(provider.status)}
                        </span>
                      </td>
                      <td>
                        {provider.userId ? (
                          <div className="cell-stack">
                            <span className="badge badge-good">Hesaba bağlı</span>
                            {provider.claimedAt ? (
                              <span className="cell-muted">
                                {formatDateTime(provider.claimedAt)}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="badge badge-warn">Sahipsiz</span>
                        )}
                      </td>
                      <td className="col-num">
                        {creditBalance === 0 ? (
                          <span className="cell-muted">0</span>
                        ) : (
                          <strong>{creditBalance}</strong>
                        )}
                      </td>
                      <td className="col-num">
                        {activeOffers === 0 ? (
                          <span className="cell-muted">0</span>
                        ) : (
                          <span className="badge badge-good">{activeOffers}</span>
                        )}
                      </td>
                      <td className="col-num">
                        <span className={packages === 0 ? 'cell-muted' : 'cell-muted'}>
                          {packages}
                        </span>
                      </td>
                      <td className="col-actions">
                        <div className="inline-actions">
                          <Link
                            className="btn btn-secondary btn-sm"
                            href={`/providers/${provider.id}`}
                          >
                            Detay
                          </Link>
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/offers?providerId=${provider.id}`}
                          >
                            Teklifler
                          </Link>
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/providers/${provider.id}/credits`}
                          >
                            Krediler
                          </Link>
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

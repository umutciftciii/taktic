import { serviceAreaLabel } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  formatDate,
  listCatalogueForFilter,
  ProviderProfile,
  ProviderStatus,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';
import { gateColumns, providerColumnGates } from '../../lib/cross-domain-projection';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { SavedViewTabs, type TabItem } from '../../components/tabs';
import { describeBusinessRegistration } from '../../lib/business-registration';
import { buildHref, parsePage, type QueryParams } from '../../lib/list-query';
import { formatCount, pageWindow } from '../../lib/pagination';

/**
 * Hizmet verenler (#12), design `providers` (ADMIN-DESIGN-001 Faz 3B, paket 2
 * `15-hizmet-verenler`).
 *
 * The API returns the whole list (`GET /providers` has no paging); the city,
 * category and ownership filters narrow it in the API and the search and the
 * status here, as before. The design adds only presentation of data this page
 * already holds: saved views counted from the same list, and pages of 50.
 *
 * Not rendered: the design's "Elle işletme ekle" (no operator create API).
 * Status names keep the existing dictionary ("Onaylandı"); the design's
 * "İş alabilir / Durduruldu" wording is a separate copy decision, as in 3A.
 */

const PATH = '/providers';
const PAGE_SIZE = 50;

/** The design's ⓘ, fitted to what the list really holds. */
const SCREEN_INFO =
  'Başvuru yapmış ve onaylanmış tüm işletmeler. Yalnız onaylı işletmeler talepleri görür ve teklif verir. Başvuru bekleyenler karar verilene kadar iş alamaz; askıya alınan bir işletmenin vitrin yayınları da durur. Sahipsiz başvurular kendi hesabı olmayan, elle ya da misafir olarak gelmiş kayıtlardır.';

/** The saved views: the queue first, then the states an operator checks. */
const VIEW_STATUSES: ProviderStatus[] = ['PENDING_REVIEW', 'APPROVED', 'SUSPENDED', 'REJECTED'];

const COLUMNS: DataColumn[] = [
  { key: 'business', label: 'İşletme' },
  { key: 'contact', label: 'İletişim' },
  { key: 'areas', label: 'Çalıştığı bölgeler' },
  { key: 'categories', label: 'Hizmetler' },
  { key: 'status', label: 'Durum' },
  { key: 'credit', label: 'Kredi', align: 'end' },
  { key: 'offers', label: 'Açık teklif', align: 'end' },
  { key: 'packages', label: 'Paket', align: 'end' },
  { key: 'actions', label: 'İşlemler', srOnly: true },
];

type RawSearchParams = {
  q?: string;
  status?: string;
  city?: string;
  category?: string;
  ownership?: string;
  page?: string;
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
  const { can } = await requireAdmin('PROVIDERS_READ');
  const canReadProviderDetail = can('PROVIDERS_READ_DETAIL');
  const canReadOffers = can('OFFERS_READ');
  const canReadProviderCredits = can('FINANCE_LEDGER_READ');
  const canReadPackagePurchases = can('PACKAGE_PURCHASES_READ');
  // The three figure columns are other domains' (balance, offers, purchases):
  // the API carries each only with its read permission, and a column the
  // session cannot read is not drawn — a `0` would be a claim the response
  // never made (API-ADMIN-CROSS-DOMAIN-PROJECTION-RBAC-001).
  const columns = gateColumns(
    COLUMNS,
    providerColumnGates({ credit: canReadProviderCredits, offers: canReadOffers, packages: canReadPackagePurchases }),
  );
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const status = normalizeStatus(params.status);
  const cityFilter = (params.city ?? '').trim();
  const categorySlug = (params.category ?? '').trim();
  const ownership = normalizeOwnership(params.ownership);
  const page = parsePage(params.page);

  const categories = await listCatalogueForFilter();

  const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));
  const categoryId = categorySlug ? categoryIdBySlug.get(categorySlug) ?? '' : '';

  // The status is applied here rather than sent to the API: the API's status
  // filter is a plain equality on the same rows, so the result is identical,
  // and reading the list once without it lets the saved views count every
  // status exactly. The other filters narrow the list in the API, as before.
  const apiQuery = new URLSearchParams();
  if (cityFilter) apiQuery.set('city', cityFilter);
  if (categoryId) apiQuery.set('categoryId', categoryId);
  if (ownership !== 'all') apiQuery.set('ownership', ownership);
  const queryString = apiQuery.toString();
  const providersPath = queryString ? `/providers?${queryString}` : '/providers';

  const providers = await apiFetch<ProviderProfile[]>(providersPath);

  const normalizedQuery = toLower(query);

  // Every filter except the status: the saved views count from this.
  const matchingOtherFilters = providers.filter((provider) => {
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

  const filtered =
    status === 'all' ? matchingOtherFilters : matchingOtherFilters.filter((provider) => provider.status === status);

  const range = pageWindow({ page, pageSize: PAGE_SIZE, total: filtered.length });
  const pageRows = filtered.slice(range.start > 0 ? range.start - 1 : 0, range.end);

  const sortedCategories = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR'),
  );

  const hasFilters =
    query.length > 0 ||
    status !== 'all' ||
    cityFilter.length > 0 ||
    categorySlug.length > 0 ||
    ownership !== 'all';

  const filterParams: QueryParams = {
    q: query,
    status: status === 'all' ? '' : status,
    city: cityFilter,
    category: categorySlug,
    ownership: ownership === 'all' ? '' : ownership,
  };

  const views: TabItem[] = [
    { key: '', label: 'Tümü', count: matchingOtherFilters.length, testId: 'provider-view-all' },
    ...VIEW_STATUSES.map((value) => ({
      key: value,
      label: statusLabel(value),
      count: matchingOtherFilters.filter((provider) => provider.status === value).length,
      testId: `provider-view-${value.toLowerCase()}`,
    })),
  ];

  const pendingCount = providers.filter((provider) => provider.status === 'PENDING_REVIEW').length;
  const summary =
    providers.length === 0
      ? hasFilters
        ? 'Filtreye uyan hizmet veren yok'
        : 'Henüz hizmet veren yok'
      : `${formatCount(providers.length)} işletme${
          pendingCount > 0 ? ` · ${formatCount(pendingCount)} başvuru karar bekliyor` : ''
        }${hasFilters ? ` · ${formatCount(filtered.length)} tanesi filtreye uyuyor` : ''}`;

  return (
    <main className="providers-page">
      <PageHeader title="Hizmet verenler" subtitle={summary} info={SCREEN_INFO} />

      <SavedViewTabs
        label="Hizmet veren görünümleri"
        items={views}
        active={status === 'all' ? '' : status}
        path={PATH}
        params={filterParams}
        param="status"
        testId="provider-views"
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Hizmet veren filtreleri"
        testId="provider-filters"
      >
        <FilterField label="Ara" htmlFor="provider-search" wide>
          <input
            id="provider-search"
            name="q"
            type="search"
            placeholder="İşletme, yetkili, telefon, e-posta, şehir"
            defaultValue={query}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Durum" htmlFor="provider-status">
          <select id="provider-status" name="status" defaultValue={status}>
            {statusFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Hizmet ili" htmlFor="provider-city">
          <input
            id="provider-city"
            name="city"
            type="text"
            placeholder="İstanbul"
            defaultValue={cityFilter}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Kategori" htmlFor="provider-category">
          <select id="provider-category" name="category" defaultValue={categorySlug}>
            <option value="">Tümü</option>
            {sortedCategories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Sahiplik" htmlFor="provider-ownership">
          <select id="provider-ownership" name="ownership" defaultValue={ownership}>
            {ownershipFilters.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {filtered.length === 0 ? (
          providers.length === 0 && !hasFilters ? (
            <EmptyState
              title="Henüz hizmet veren yok."
              description="Bir işletme başvuru formunu gönderdiğinde burada listelenir."
            />
          ) : (
            <EmptyState
              title="Filtrelere uygun hizmet veren bulunamadı."
              description="Aramayı daraltabilir veya filtreleri temizleyebilirsiniz."
              action={
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  Filtreleri temizle
                </Link>
              }
            />
          )
        ) : (
          <DataTable caption="Hizmet verenler" columns={columns} minWidth={1100} testId="provider-table">
            {pageRows.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                canReadProviderDetail={canReadProviderDetail}
                canReadOffers={canReadOffers}
                canReadProviderCredits={canReadProviderCredits}
                canReadPackagePurchases={canReadPackagePurchases}
              />
            ))}
          </DataTable>
        )}
        {filtered.length > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={range.page}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            noun="hizmet veren"
            summaryTestId="provider-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function ProviderRow({
  provider,
  canReadProviderDetail,
  canReadOffers,
  canReadProviderCredits,
  canReadPackagePurchases,
}: {
  provider: ProviderProfile;
  canReadProviderDetail: boolean;
  canReadOffers: boolean;
  canReadProviderCredits: boolean;
  canReadPackagePurchases: boolean;
}) {
  const providerCategories = provider.serviceCategories ?? [];
  const visibleCategories = providerCategories.slice(0, 2);
  const extraCategories = providerCategories.length - visibleCategories.length;
  const creditBalance = provider.creditBalance ?? 0;
  const activeOffers = provider.activeOffersCount ?? 0;
  const packages = provider.packagePurchasesCount ?? 0;

  return (
    <tr data-testid="provider-row" data-provider-id={provider.id} data-status={provider.status}>
      <td>
        <div className="cell-stack">
          {canReadProviderDetail ? (
            <Link href={`/providers/${provider.id}`}>
              <strong>{provider.businessName}</strong>
            </Link>
          ) : (
            <strong>{provider.businessName}</strong>
          )}
          <span className="cell-muted">{provider.contactName}</span>
          {/* CMP-006 PR-C: masked; the list never carries a raw number. */}
          <span className="cell-muted" data-testid="provider-registration">
            {describeBusinessRegistration(provider.businessRegistration)}
          </span>
          <span className="cell-muted">Kayıt: {formatDate(provider.createdAt)}</span>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          {provider.phone ? (
            <a className="cell-link cell-nowrap" href={`tel:${provider.phone}`}>
              {provider.phone}
            </a>
          ) : null}
          {provider.email ? (
            <a className="cell-link cell-muted cell-break" href={`mailto:${provider.email}`}>
              {provider.email}
            </a>
          ) : null}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          {/*
            Two different facts, and the second is the one that decides
            anything: the location the profile has carried since before
            coverage was a list, then the areas matching actually reads. The
            filter above selects on the areas, so a row surfaced by it has to
            show why.
          */}
          <span>
            {provider.serviceAreas.length === 0
              ? 'Bölge tanımlı değil'
              : provider.serviceAreas.map(serviceAreaLabel).join(' · ')}
          </span>
          <span className="cell-muted">
            Adres: {provider.city}/{provider.district}
            {provider.addressNote ? ` · ${provider.addressNote}` : ''}
          </span>
        </div>
      </td>
      <td>
        <div className="badge-row">
          {visibleCategories.length === 0 ? (
            <span className="cell-muted">—</span>
          ) : (
            visibleCategories.map((item) => (
              <span key={item.id} className="badge badge-muted">
                {item.category.name}
              </span>
            ))
          )}
          {extraCategories > 0 ? <span className="cell-muted">+{extraCategories}</span> : null}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
          {provider.userId ? (
            <span className="cell-muted" data-testid="provider-ownership">
              Hesaba bağlı{provider.claimedAt ? ` · ${formatDate(provider.claimedAt)}` : ''}
            </span>
          ) : (
            <span className="cell-muted" data-testid="provider-ownership">
              Sahipsiz — kendi hesabı yok
            </span>
          )}
        </div>
      </td>
      {canReadProviderCredits ? (
        <td className="is-num" data-testid="provider-credit">
          {creditBalance === 0 ? <span className="cell-muted">0</span> : <strong>{creditBalance}</strong>}
        </td>
      ) : null}
      {canReadOffers ? (
        <td className="is-num" data-testid="provider-active-offers">
          {activeOffers === 0 ? (
            <span className="cell-muted">0</span>
          ) : (
            <span className="badge badge-good">{activeOffers}</span>
          )}
        </td>
      ) : null}
      {canReadPackagePurchases ? (
        <td className="is-num" data-testid="provider-packages">
          <span className="cell-muted">{packages}</span>
        </td>
      ) : null}
      <td className="col-actions">
        <div className="inline-actions">
          {canReadProviderDetail ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={`/providers/${provider.id}`}
              aria-label={`Aç: ${provider.businessName}`}
            >
              Aç
            </Link>
          ) : null}
          {canReadOffers ? (
            <Link className="btn btn-ghost btn-sm" href={`/offers?providerId=${provider.id}`}>
              Teklifler
            </Link>
          ) : null}
          {canReadProviderCredits ? (
            <Link className="btn btn-ghost btn-sm" href={`/providers/${provider.id}/credits`}>
              Krediler
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

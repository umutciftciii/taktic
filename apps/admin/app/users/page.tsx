import Link from 'next/link';
import {
  AdminUserSortDirection,
  AdminUserSortField,
  AdminUserSummary,
  AdminUsersResponse,
  apiFetch,
  CUSTOMER_ORIGIN_VALUES,
  CustomerOrigin,
  customerOriginBadgeClass,
  customerOriginLabel,
  formatDate,
  formatDateTime,
  requireAdmin,
  UserRole,
  USER_ROLE_VALUES,
  USER_SORT_FIELDS,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../lib/api';
import { EmptyState } from '../../components/empty-state';
import { PageHeader } from '../../components/page-header';
import { SectionCard } from '../../components/section-card';

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_BY: AdminUserSortField = 'createdAt';
const DEFAULT_SORT_DIR: AdminUserSortDirection = 'desc';

type RawSearchParams = {
  q?: string;
  role?: string;
  isActive?: string;
  customerOrigin?: string;
  hasPassword?: string;
  createdFrom?: string;
  createdTo?: string;
  lastLoginFrom?: string;
  lastLoginTo?: string;
  sortBy?: string;
  sortDir?: string;
  page?: string;
  pageSize?: string;
};

type AdminUsersPageProps = {
  searchParams: Promise<RawSearchParams>;
};

const SORT_LABEL: Record<AdminUserSortField, string> = {
  name: 'İsim',
  email: 'E-posta',
  role: 'Rol',
  createdAt: 'Kayıt tarihi',
  lastLoginAt: 'Son giriş',
  isActive: 'Durum',
};

function normalizeSortBy(value: string | undefined): AdminUserSortField {
  if (value && (USER_SORT_FIELDS as readonly string[]).includes(value)) {
    return value as AdminUserSortField;
  }
  return DEFAULT_SORT_BY;
}

function normalizeSortDir(value: string | undefined): AdminUserSortDirection {
  if (value === 'asc') return 'asc';
  if (value === 'desc') return 'desc';
  return DEFAULT_SORT_DIR;
}

function normalizeRole(value: string | undefined): UserRole | '' {
  if (value && (USER_ROLE_VALUES as readonly string[]).includes(value)) {
    return value as UserRole;
  }
  return '';
}

function normalizeCustomerOrigin(value: string | undefined): CustomerOrigin | '' {
  if (value && (CUSTOMER_ORIGIN_VALUES as readonly string[]).includes(value)) {
    return value as CustomerOrigin;
  }
  return '';
}

function normalizeBool(value: string | undefined): 'true' | 'false' | '' {
  if (value === 'true') return 'true';
  if (value === 'false') return 'false';
  return '';
}

function normalizePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function normalizePageSize(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, 100);
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) continue;
    query.set(key, String(value));
  }
  const str = query.toString();
  return str ? `?${str}` : '';
}

function buildPageHref(
  baseParams: Record<string, string | number | undefined>,
  page: number,
): string {
  const params = { ...baseParams };
  if (page <= 1) delete params.page;
  else params.page = page;
  return `/users${buildQueryString(params)}`;
}

export default async function AdminUsersPage({ searchParams }: AdminUsersPageProps) {
  await requireAdmin();

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const role = normalizeRole(params.role);
  const isActive = normalizeBool(params.isActive);
  const customerOrigin = normalizeCustomerOrigin(params.customerOrigin);
  const hasPassword = normalizeBool(params.hasPassword);
  const createdFrom = (params.createdFrom ?? '').trim();
  const createdTo = (params.createdTo ?? '').trim();
  const lastLoginFrom = (params.lastLoginFrom ?? '').trim();
  const lastLoginTo = (params.lastLoginTo ?? '').trim();
  const sortBy = normalizeSortBy(params.sortBy);
  const sortDir = normalizeSortDir(params.sortDir);
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);

  const apiQuery = new URLSearchParams();
  apiQuery.set('page', String(page));
  apiQuery.set('pageSize', String(pageSize));
  apiQuery.set('sortBy', sortBy);
  apiQuery.set('sortDir', sortDir);
  if (q) apiQuery.set('q', q);
  if (role) apiQuery.set('role', role);
  if (isActive) apiQuery.set('isActive', isActive);
  if (customerOrigin) apiQuery.set('customerOrigin', customerOrigin);
  if (hasPassword) apiQuery.set('hasPassword', hasPassword);
  if (createdFrom) apiQuery.set('createdFrom', createdFrom);
  if (createdTo) apiQuery.set('createdTo', createdTo);
  if (lastLoginFrom) apiQuery.set('lastLoginFrom', lastLoginFrom);
  if (lastLoginTo) apiQuery.set('lastLoginTo', lastLoginTo);

  const response = await apiFetch<AdminUsersResponse>(`/users?${apiQuery.toString()}`);

  const hasFilters = Boolean(
    q ||
      role ||
      isActive ||
      customerOrigin ||
      hasPassword ||
      createdFrom ||
      createdTo ||
      lastLoginFrom ||
      lastLoginTo ||
      sortBy !== DEFAULT_SORT_BY ||
      sortDir !== DEFAULT_SORT_DIR,
  );

  const baseParams: Record<string, string | number | undefined> = {
    q,
    role: role || undefined,
    isActive: isActive || undefined,
    customerOrigin: customerOrigin || undefined,
    hasPassword: hasPassword || undefined,
    createdFrom,
    createdTo,
    lastLoginFrom,
    lastLoginTo,
    sortBy: sortBy !== DEFAULT_SORT_BY ? sortBy : undefined,
    sortDir: sortDir !== DEFAULT_SORT_DIR ? sortDir : undefined,
    pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined,
  };

  const startIndex = response.total === 0 ? 0 : (response.page - 1) * response.pageSize + 1;
  const endIndex = Math.min(response.page * response.pageSize, response.total);

  return (
    <main className="users-page">
      <PageHeader
        title="Kullanıcılar"
        subtitle="Platformdaki tüm kullanıcıları görüntüleyin; rol, durum ve şifre bilgilerine göre filtreleyin."
      />

      <form className="admin-toolbar" method="get" action="/users">
        <div className="admin-toolbar-field admin-toolbar-search">
          <label htmlFor="user-search">Ara</label>
          <input
            id="user-search"
            name="q"
            type="search"
            placeholder="İsim, telefon, e-posta"
            defaultValue={q}
            autoComplete="off"
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-role">Rol</label>
          <select id="user-role" name="role" defaultValue={role}>
            <option value="">Tümü</option>
            {USER_ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {userRoleLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-active">Durum</label>
          <select id="user-active" name="isActive" defaultValue={isActive}>
            <option value="">Tümü</option>
            <option value="true">Aktif</option>
            <option value="false">Pasif</option>
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-has-password">Şifre</label>
          <select id="user-has-password" name="hasPassword" defaultValue={hasPassword}>
            <option value="">Tümü</option>
            <option value="true">Şifre var</option>
            <option value="false">Şifre yok</option>
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-origin">Müşteri tipi</label>
          <select id="user-origin" name="customerOrigin" defaultValue={customerOrigin}>
            <option value="">Tümü</option>
            {CUSTOMER_ORIGIN_VALUES.map((origin) => (
              <option key={origin} value={origin}>
                {customerOriginLabel(origin)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-created-from">Kayıt (başlangıç)</label>
          <input
            id="user-created-from"
            name="createdFrom"
            type="date"
            defaultValue={createdFrom}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-created-to">Kayıt (bitiş)</label>
          <input
            id="user-created-to"
            name="createdTo"
            type="date"
            defaultValue={createdTo}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-login-from">Son giriş (başlangıç)</label>
          <input
            id="user-login-from"
            name="lastLoginFrom"
            type="date"
            defaultValue={lastLoginFrom}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-login-to">Son giriş (bitiş)</label>
          <input
            id="user-login-to"
            name="lastLoginTo"
            type="date"
            defaultValue={lastLoginTo}
          />
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-sort">Sıralama</label>
          <select id="user-sort" name="sortBy" defaultValue={sortBy}>
            {USER_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-toolbar-field">
          <label htmlFor="user-dir">Yön</label>
          <select id="user-dir" name="sortDir" defaultValue={sortDir}>
            <option value="desc">Azalan</option>
            <option value="asc">Artan</option>
          </select>
        </div>
        <div className="admin-toolbar-actions">
          <span className="admin-toolbar-summary">
            {response.total === 0
              ? '0 kullanıcı'
              : `${startIndex}-${endIndex} / ${response.total} kullanıcı`}
          </span>
          <button className="btn btn-secondary btn-sm" type="submit">
            Uygula
          </button>
          {hasFilters ? (
            <Link className="btn btn-ghost btn-sm" href="/users">
              Temizle
            </Link>
          ) : null}
        </div>
      </form>

      <SectionCard
        title="Kullanıcı listesi"
        subtitle={`Sayfa ${response.page} · ${response.pageSize} kullanıcı/sayfa`}
        padded={false}
      >
        {response.items.length === 0 ? (
          <EmptyState
            title="Kullanıcı bulunamadı"
            description={
              hasFilters
                ? 'Aramayı daraltabilir veya filtreleri temizleyebilirsiniz.'
                : 'Kayıtlı kullanıcılar eklendikçe burada listelenecek.'
            }
            action={
              hasFilters ? (
                <Link className="btn btn-secondary btn-sm" href="/users">
                  Filtreleri temizle
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kullanıcı</th>
                  <th>Rol</th>
                  <th>Kaynak / Müşteri Tipi</th>
                  <th>Telefon</th>
                  <th>Durum</th>
                  <th>Şifre</th>
                  <th className="col-num">Provider Profili</th>
                  <th className="col-num">Aktif Oturum</th>
                  <th>Son Giriş</th>
                  <th>Kayıt Tarihi</th>
                  <th className="col-actions">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {response.items.map((user) => (
                  <UserRow key={user.id} user={user} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {response.total > response.pageSize ? (
        <nav
          className="inline-actions"
          style={{ marginTop: 16, justifyContent: 'space-between' }}
        >
          {response.page > 1 ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page - 1)}
            >
              ← Önceki
            </Link>
          ) : (
            <span />
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Sayfa {response.page}
          </span>
          {response.hasNextPage ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={buildPageHref(baseParams, response.page + 1)}
            >
              Sonraki →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}

function UserRow({ user }: { user: AdminUserSummary }) {
  const displayName = user.name ?? user.email ?? user.phone ?? '—';

  return (
    <tr>
      <td>
        <div className="cell-stack">
          <Link href={`/users/${user.id}`}>
            <strong>{displayName}</strong>
          </Link>
          {user.email ? <span className="cell-muted">{user.email}</span> : null}
        </div>
      </td>
      <td>
        <span className={userRoleBadgeClass(user.role)}>{userRoleLabel(user.role)}</span>
      </td>
      <td>
        {user.role === 'CUSTOMER' ? (
          <span className={customerOriginBadgeClass(user.customerOrigin)}>
            {customerOriginLabel(user.customerOrigin)}
          </span>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td>
        {user.phone ? (
          <a className="cell-link" href={`tel:${user.phone}`}>
            {user.phone}
          </a>
        ) : (
          <span className="cell-muted">-</span>
        )}
      </td>
      <td>
        {user.isActive ? (
          <span className="badge badge-good">Aktif</span>
        ) : (
          <span className="badge badge-bad">Pasif</span>
        )}
      </td>
      <td>
        {user.hasPassword ? (
          <span className="badge badge-good">Şifre var</span>
        ) : (
          <span className="badge badge-warn">Şifre yok</span>
        )}
      </td>
      <td className="col-num">
        {user.providerProfileCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          user.providerProfileCount
        )}
      </td>
      <td className="col-num">
        {user.activeSessionCount === 0 ? (
          <span className="cell-muted">0</span>
        ) : (
          <span className="badge badge-good">{user.activeSessionCount}</span>
        )}
      </td>
      <td>
        {user.lastLoginAt ? (
          formatDateTime(user.lastLoginAt)
        ) : (
          <span className="cell-muted">Hiç</span>
        )}
      </td>
      <td>{formatDate(user.createdAt)}</td>
      <td className="col-actions">
        <div className="inline-actions">
          <Link className="btn btn-secondary btn-sm" href={`/users/${user.id}`}>
            Detay
          </Link>
        </div>
      </td>
    </tr>
  );
}

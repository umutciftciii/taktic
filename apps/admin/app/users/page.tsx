import Link from 'next/link';
import {
  AdminUserSortDirection,
  AdminUserSortField,
  AdminUserSummary,
  AdminUsersResponse,
  apiFetch,
  formatDate,
  formatDateTime,
  requireAdmin,
  USER_SORT_FIELDS,
} from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/data-table';
import { EmptyState } from '../../components/empty-state';
import { FilterBar, FilterField } from '../../components/filter-bar';
import { PageHeader } from '../../components/page-header';
import { Pagination } from '../../components/pagination';
import { buildHref, type QueryParams } from '../../lib/list-query';
import { formatCount } from '../../lib/pagination';

/**
 * Yönetici hesapları (#47), design `list:admins` (ADMIN-DESIGN-001 Faz 4).
 *
 * The one list Faz 3G left on the Faz 1 toolbar: it now reads through the
 * shared filter bar, table and page footer like every other list. The query
 * names, the API call and the columns are the ones it always had, so every
 * bookmark opens the same view. Creating an account stays root-only
 * (`POST /users`), so the header action is a super admin's alone.
 */

const PATH = '/users';

const SCREEN_INFO =
  'Panele giriş yapabilen personel hesapları. Durum pasif olan hesap giriş yapamaz; "Şifre yok" hesabın davet bağlantısıyla henüz şifre belirlemediğini gösterir. Bir hesabı açınca rolleri, oturumları ve hesap işlemleri görünür.';

const COLUMNS: DataColumn[] = [
  { key: 'user', label: 'Kullanıcı' },
  { key: 'email', label: 'E-posta' },
  { key: 'phone', label: 'Telefon' },
  { key: 'status', label: 'Durum' },
  { key: 'password', label: 'Şifre' },
  { key: 'sessions', label: 'Aktif oturum', align: 'end' },
  { key: 'lastLogin', label: 'Son giriş' },
  { key: 'createdAt', label: 'Kayıt tarihi' },
  { key: 'actions', label: 'İşlem', srOnly: true },
];

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SORT_BY: AdminUserSortField = 'createdAt';
const DEFAULT_SORT_DIR: AdminUserSortDirection = 'desc';

type RawSearchParams = {
  q?: string;
  isActive?: string;
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

export default async function AdminUsersPage({ searchParams }: AdminUsersPageProps) {
  const { isSuperAdmin } = await requireAdmin('ADMIN_USERS_READ');

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const isActive = normalizeBool(params.isActive);
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
  if (isActive) apiQuery.set('isActive', isActive);
  if (hasPassword) apiQuery.set('hasPassword', hasPassword);
  if (createdFrom) apiQuery.set('createdFrom', createdFrom);
  if (createdTo) apiQuery.set('createdTo', createdTo);
  if (lastLoginFrom) apiQuery.set('lastLoginFrom', lastLoginFrom);
  if (lastLoginTo) apiQuery.set('lastLoginTo', lastLoginTo);

  const response = await apiFetch<AdminUsersResponse>(`/users?${apiQuery.toString()}`);

  const hasFilters = Boolean(
    q ||
      isActive ||
      hasPassword ||
      createdFrom ||
      createdTo ||
      lastLoginFrom ||
      lastLoginTo ||
      sortBy !== DEFAULT_SORT_BY ||
      sortDir !== DEFAULT_SORT_DIR,
  );

  // The same query names as before; the defaults are written as no parameter.
  const filterParams: QueryParams = {
    q,
    isActive: isActive || undefined,
    hasPassword: hasPassword || undefined,
    createdFrom,
    createdTo,
    lastLoginFrom,
    lastLoginTo,
    sortBy: sortBy !== DEFAULT_SORT_BY ? sortBy : undefined,
    sortDir: sortDir !== DEFAULT_SORT_DIR ? sortDir : undefined,
    pageSize: pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined,
  };

  const summary =
    response.total === 0
      ? hasFilters
        ? 'Filtreye uyan hesap yok'
        : 'Henüz yönetici hesabı yok'
      : hasFilters
        ? `${formatCount(response.total)} hesap filtreye uyuyor`
        : `${formatCount(response.total)} yönetici hesabı`;

  return (
    <main className="users-page">
      <PageHeader
        title="Yönetici hesapları"
        subtitle={summary}
        info={SCREEN_INFO}
        actions={
          // Creating a staff account is root-only (`POST /users`).
          isSuperAdmin ? (
            <Link className="btn btn-primary btn-sm" href="/users/new">
              Yeni yönetici hesabı
            </Link>
          ) : undefined
        }
      />

      <FilterBar
        key={buildHref(PATH, filterParams)}
        action={PATH}
        clearHref={hasFilters ? PATH : null}
        label="Hesap filtreleri"
        preserve={{ pageSize: filterParams.pageSize }}
        testId="user-filters"
      >
        <FilterField label="Ara" htmlFor="user-search" wide>
          <input
            id="user-search"
            name="q"
            type="search"
            placeholder="İsim, telefon, e-posta"
            defaultValue={q}
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Durum" htmlFor="user-active">
          <select id="user-active" name="isActive" defaultValue={isActive}>
            <option value="">Tümü</option>
            <option value="true">Aktif</option>
            <option value="false">Pasif</option>
          </select>
        </FilterField>
        <FilterField label="Şifre" htmlFor="user-has-password">
          <select id="user-has-password" name="hasPassword" defaultValue={hasPassword}>
            <option value="">Tümü</option>
            <option value="true">Şifre var</option>
            <option value="false">Şifre yok</option>
          </select>
        </FilterField>
        <FilterField label="Kayıt (başlangıç)" htmlFor="user-created-from">
          <input id="user-created-from" name="createdFrom" type="date" defaultValue={createdFrom} />
        </FilterField>
        <FilterField label="Kayıt (bitiş)" htmlFor="user-created-to">
          <input id="user-created-to" name="createdTo" type="date" defaultValue={createdTo} />
        </FilterField>
        <FilterField label="Son giriş (başlangıç)" htmlFor="user-login-from">
          <input id="user-login-from" name="lastLoginFrom" type="date" defaultValue={lastLoginFrom} />
        </FilterField>
        <FilterField label="Son giriş (bitiş)" htmlFor="user-login-to">
          <input id="user-login-to" name="lastLoginTo" type="date" defaultValue={lastLoginTo} />
        </FilterField>
        <FilterField label="Sıralama" htmlFor="user-sort">
          <select id="user-sort" name="sortBy" defaultValue={sortBy}>
            {USER_SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {SORT_LABEL[field]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Yön" htmlFor="user-dir">
          <select id="user-dir" name="sortDir" defaultValue={sortDir}>
            <option value="desc">Azalan</option>
            <option value="asc">Artan</option>
          </select>
        </FilterField>
      </FilterBar>

      <div className="data-list-card">
        {response.items.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? 'Filtreye uygun hesap bulunamadı.'
                : response.total > 0
                  ? 'Bu sayfada hesap yok.'
                  : 'Henüz yönetici hesabı yok.'
            }
            description={
              hasFilters
                ? 'Aramayı daraltabilir veya filtreleri temizleyebilirsiniz.'
                : 'Bir yönetici hesabı oluşturulduğunda burada listelenir.'
            }
            action={
              hasFilters || response.total > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={PATH}>
                  {hasFilters ? 'Filtreleri temizle' : 'İlk sayfaya dön'}
                </Link>
              ) : null
            }
          />
        ) : (
          <DataTable caption="Yönetici hesapları" columns={COLUMNS} minWidth={1000} testId="user-table">
            {response.items.map((user) => (
              <UserRow key={user.id} user={user} />
            ))}
          </DataTable>
        )}
        {response.total > 0 ? (
          <Pagination
            path={PATH}
            params={filterParams}
            page={response.page}
            pageSize={response.pageSize}
            total={response.total}
            hasNextPage={response.hasNextPage}
            noun="hesap"
            summaryTestId="user-count"
          />
        ) : null}
      </div>
    </main>
  );
}

function UserRow({ user }: { user: AdminUserSummary }) {
  const displayName = user.name ?? user.email ?? user.phone ?? '—';

  return (
    <tr data-testid="user-row" data-user-id={user.id}>
      <td>
        <div className="cell-stack">
          <Link href={`/users/${user.id}`}>
            <strong>{displayName}</strong>
          </Link>
        </div>
      </td>
      <td>
        {user.email ? (
          <a className="cell-link cell-muted cell-break" href={`mailto:${user.email}`}>
            {user.email}
          </a>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td className="cell-nowrap">
        {user.phone ? (
          <a className="cell-link" href={`tel:${user.phone}`}>
            {user.phone}
          </a>
        ) : (
          <span className="cell-muted">—</span>
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
      <td className="is-num">
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
        <Link className="btn btn-secondary btn-sm" href={`/users/${user.id}`} aria-label={`Aç: ${displayName}`}>
          Aç
        </Link>
      </td>
    </tr>
  );
}

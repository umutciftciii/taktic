import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AdminUserDetailResponse,
  AdminUserProviderProfile,
  apiFetch,
  customerOriginBadgeClass,
  customerOriginLabel,
  formatDate,
  formatDateTime,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../../lib/api';
import { EmptyState } from '../../../components/empty-state';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';

type AdminUserDetailPageProps = {
  params: Promise<{ id: string }>;
};

function isBackendNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const parsed = JSON.parse(error.message) as { statusCode?: unknown };
    return parsed?.statusCode === 404;
  } catch {
    return error.message.includes('User not found');
  }
}

export default async function AdminUserDetailPage({ params }: AdminUserDetailPageProps) {
  await requireAdmin();
  const { id } = await params;

  let response: AdminUserDetailResponse;
  try {
    response = await apiFetch<AdminUserDetailResponse>(`/users/${id}`);
  } catch (error) {
    if (isBackendNotFound(error)) {
      notFound();
    }
    throw error;
  }

  const { user, metrics, providerProfiles, customerSummary } = response;

  const displayName = user.name ?? user.email ?? user.phone ?? '—';
  const subtitleParts: string[] = [];
  if (user.phone) subtitleParts.push(user.phone);
  if (user.email) subtitleParts.push(user.email);

  return (
    <main className="user-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kullanıcılar', href: '/users' },
          { label: displayName },
        ]}
        title={displayName}
        subtitle={
          <>
            <span className={userRoleBadgeClass(user.role)}>{userRoleLabel(user.role)}</span>
            {' '}
            {user.isActive ? (
              <span className="badge badge-good">Aktif</span>
            ) : (
              <span className="badge badge-bad">Pasif</span>
            )}
            {subtitleParts.length > 0 ? (
              <span className="muted"> · {subtitleParts.join(' · ')}</span>
            ) : null}
          </>
        }
        actions={
          <Link className="btn btn-ghost btn-sm" href="/users">
            ← Listeye dön
          </Link>
        }
      />

      <section className="stat-grid">
        <StatCard label="Aktif oturum" value={metrics.activeSessionCount} />
        <StatCard label="Provider profili" value={metrics.providerProfileCount} />
        <StatCard label="Müşteri talebi" value={metrics.customerRequestCount} />
        <StatCard label="Müşteri teklifi" value={metrics.customerOfferCount} />
      </section>

      <div className="provider-detail-card-grid">
        <SectionCard title="Profil & İletişim" className="card-wide">
          <dl className="meta-row">
            <dt>Ad</dt>
            <dd>{user.name ?? '-'}</dd>
            <dt>E-posta</dt>
            <dd>
              {user.email ? (
                <a className="cell-link" href={`mailto:${user.email}`}>
                  {user.email}
                </a>
              ) : (
                '-'
              )}
            </dd>
            <dt>Telefon</dt>
            <dd>
              {user.phone ? (
                <a className="cell-link" href={`tel:${user.phone}`}>
                  {user.phone}
                </a>
              ) : (
                '-'
              )}
            </dd>
            <dt>Rol</dt>
            <dd>
              <span className={userRoleBadgeClass(user.role)}>{userRoleLabel(user.role)}</span>
            </dd>
            <dt>Durum</dt>
            <dd>
              {user.isActive ? (
                <span className="badge badge-good">Aktif</span>
              ) : (
                <span className="badge badge-bad">Pasif</span>
              )}
            </dd>
            <dt>Şifre</dt>
            <dd>
              {user.hasPassword ? (
                <span className="badge badge-good">Şifre var</span>
              ) : (
                <span className="badge badge-warn">Şifre yok</span>
              )}
            </dd>
            {user.role === 'CUSTOMER' ? (
              <>
                <dt>Müşteri tipi</dt>
                <dd>
                  <span className={customerOriginBadgeClass(user.customerOrigin)}>
                    {customerOriginLabel(user.customerOrigin)}
                  </span>
                </dd>
              </>
            ) : null}
            <dt>Kayıt tarihi</dt>
            <dd>{formatDateTime(user.createdAt)}</dd>
            <dt>Son giriş</dt>
            <dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '-'}</dd>
            <dt>Güncellenme</dt>
            <dd>{formatDateTime(user.updatedAt)}</dd>
          </dl>
          <details style={{ marginTop: 12 }}>
            <summary className="cell-muted" style={{ cursor: 'pointer', fontSize: 12 }}>
              Teknik bilgi
            </summary>
            <dl className="meta-row" style={{ marginTop: 8 }}>
              <dt>Kullanıcı ID</dt>
              <dd>
                <code style={{ fontSize: 12 }}>{user.id}</code>
              </dd>
            </dl>
          </details>
        </SectionCard>

        {user.role === 'PROVIDER' ? (
          <SectionCard
            title="Provider profilleri"
            subtitle={
              providerProfiles.length > 0 ? `Toplam ${providerProfiles.length}` : undefined
            }
            className="card-wide"
            padded={providerProfiles.length === 0}
          >
            {providerProfiles.length === 0 ? (
              <EmptyState title="Bu kullanıcıya bağlı provider profili yok." />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>İşletme</th>
                      <th>Durum</th>
                      <th>Şehir / İlçe</th>
                      <th>Kayıt tarihi</th>
                      <th className="col-actions">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerProfiles.map((profile) => (
                      <ProviderProfileRow key={profile.id} profile={profile} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}

        {user.role === 'CUSTOMER' && customerSummary ? (
          <SectionCard title="Müşteri özeti" className="card-wide">
            <dl className="meta-row">
              <dt>Talep sayısı</dt>
              <dd>{customerSummary.requestCount}</dd>
              <dt>Teklif sayısı</dt>
              <dd>{customerSummary.offerCount}</dd>
              <dt>Kabul edilen teklif</dt>
              <dd>
                {customerSummary.acceptedOfferCount === 0 ? (
                  '0'
                ) : (
                  <span className="badge badge-good">
                    {customerSummary.acceptedOfferCount}
                  </span>
                )}
              </dd>
              <dt>Son talep</dt>
              <dd>
                {customerSummary.lastRequestAt
                  ? formatDateTime(customerSummary.lastRequestAt)
                  : '-'}
              </dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              <Link className="btn btn-secondary btn-sm" href={`/customers/${user.id}`}>
                Müşteri detayını aç
              </Link>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title="Güvenlik & Yönetim" className="card-wide">
          <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
            Kullanıcı durum yönetimi ve şifre sıfırlama sonraki fazda eklenecek.
          </p>
        </SectionCard>
      </div>
    </main>
  );
}

function ProviderProfileRow({ profile }: { profile: AdminUserProviderProfile }) {
  return (
    <tr>
      <td>
        <Link href={`/providers/${profile.id}`}>
          <strong>{profile.businessName}</strong>
        </Link>
      </td>
      <td>
        <span className={statusBadgeClass(profile.status)}>{statusLabel(profile.status)}</span>
      </td>
      <td>
        {profile.city}
        {profile.district ? `/${profile.district}` : ''}
      </td>
      <td>{formatDate(profile.createdAt)}</td>
      <td className="col-actions">
        <Link className="btn btn-secondary btn-sm" href={`/providers/${profile.id}`}>
          Detay
        </Link>
      </td>
    </tr>
  );
}

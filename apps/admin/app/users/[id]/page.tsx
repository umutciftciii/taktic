import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AdminUserDetailResponse,
  apiFetch,
  formatDateTime,
  requireAdmin,
  userRoleBadgeClass,
  userRoleLabel,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { StatCard } from '../../../components/stat-card';
import { updateUserStatusAction } from '../actions';

type SearchParams = {
  statusError?: string;
};

type AdminUserDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<SearchParams>;
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

export default async function AdminUserDetailPage({
  params,
  searchParams,
}: AdminUserDetailPageProps) {
  const actor = await requireAdmin();
  const { id } = await params;
  const search = (await searchParams) ?? {};

  let response: AdminUserDetailResponse;
  try {
    response = await apiFetch<AdminUserDetailResponse>(`/users/${id}`);
  } catch (error) {
    if (isBackendNotFound(error)) {
      notFound();
    }
    throw error;
  }

  const { user, metrics } = response;
  const isSelf = actor.id === user.id;

  const displayName = user.name ?? user.email ?? user.phone ?? '—';
  const subtitleParts: string[] = [];
  if (user.phone) subtitleParts.push(user.phone);
  if (user.email) subtitleParts.push(user.email);

  return (
    <main className="user-detail-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin Kullanıcıları', href: '/users' },
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

        <SectionCard title="Güvenlik & Yönetim" className="card-wide">
          <dl className="meta-row">
            <dt>Durum</dt>
            <dd>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                {user.isActive ? (
                  <span className="badge badge-good">Aktif</span>
                ) : (
                  <span className="badge badge-bad">Pasif</span>
                )}
                {isSelf && user.isActive ? null : (
                  <form action={updateUserStatusAction}>
                    <input type="hidden" name="userId" value={user.id} />
                    <input
                      type="hidden"
                      name="isActive"
                      value={user.isActive ? 'false' : 'true'}
                    />
                    <button
                      type="submit"
                      className={
                        user.isActive
                          ? 'btn btn-secondary btn-sm'
                          : 'btn btn-primary btn-sm'
                      }
                    >
                      {user.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                    </button>
                  </form>
                )}
              </div>
              <div
                className="muted"
                style={{ marginTop: 6, fontSize: 12, lineHeight: 1.4 }}
              >
                {isSelf
                  ? 'Kendi hesabınızı pasifleştiremezsiniz.'
                  : user.isActive
                    ? 'Pasif kullanıcılar giriş yapamaz.'
                    : 'Aktifleştirilen kullanıcı yeniden giriş yapabilir.'}
              </div>
              {search.statusError ? (
                <div
                  role="alert"
                  style={{
                    marginTop: 8,
                    padding: 10,
                    borderRadius: 8,
                    background: 'rgba(220, 38, 38, 0.08)',
                    border: '1px solid rgba(220, 38, 38, 0.25)',
                    color: 'rgb(153, 27, 27)',
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {search.statusError}
                </div>
              ) : null}
            </dd>
          </dl>
          <p className="muted" style={{ marginTop: 12, lineHeight: 1.5 }}>
            Rol değişikliği ve şifre sıfırlama sonraki fazda eklenecek.
          </p>
        </SectionCard>
      </div>
    </main>
  );
}

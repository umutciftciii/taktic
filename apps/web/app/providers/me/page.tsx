import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderDashboard,
  statusLabel,
  statusBadgeClass,
} from '../../../lib/api';

export default async function MyProviderPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'PROVIDER') {
    redirect('/login?redirectTo=/providers/me');
  }

  const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
  const provider = dashboard.provider;

  if (!provider) {
    return (
      <main>
        <p className="breadcrumbs">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>Panelim</span>
        </p>
        <header className="page-header">
          <h1 className="page-title">Hizmet Veren Paneli</h1>
        </header>
        <div className="empty-state">
          <h2>Henüz hizmet veren profiliniz yok</h2>
          <p className="muted">
            Talep eşleşmelerini ve teklif akışını kullanmak için önce profil oluşturun.
          </p>
          <Link className="btn btn-primary" href="/providers/register" style={{ marginTop: 8 }}>
            Hizmet veren profili oluştur
          </Link>
        </div>
      </main>
    );
  }

  const canUseOfferFlow = provider.status === 'APPROVED';

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Ana sayfa</Link>
        <span aria-hidden="true">/</span>
        <span>Panelim</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{provider.businessName}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>{' '}
          <span className="muted">· {provider.city}/{provider.district}</span>
        </p>
      </header>

      <ProviderStatusNotice provider={provider} />

      <section className="stat-grid">
        <div className="stat-card">
          <span className="muted">Kredi bakiyesi</span>
          <span className="metric">{dashboard.creditBalance ?? 0}</span>
        </div>
        <div className="stat-card">
          <span className="muted">Aktif teklifler</span>
          <span className="metric">{dashboard.activeOffersCount ?? 0}</span>
        </div>
        <div className="stat-card">
          <span className="muted">Toplam teklif</span>
          <span className="metric">{dashboard.recentOffersCount ?? 0}</span>
        </div>
        <div className="stat-card">
          <span className="muted">Uygun onaylı talep</span>
          <span className="metric">{dashboard.matchingApprovedRequestsCount ?? 0}</span>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 18 }}>Hızlı işlemler</h2>
        <div className="inline-actions">
          {canUseOfferFlow ? (
            <Link className="btn btn-primary" href={`/providers/${provider.id}/requests`}>
              Uygun Talepler
            </Link>
          ) : null}
          <Link className="btn btn-secondary" href={`/providers/${provider.id}/offers`}>
            Tekliflerim
          </Link>
          <Link className="btn btn-secondary" href={`/providers/${provider.id}/credits`}>
            Kredilerim
          </Link>
          <Link className="btn btn-secondary" href={`/providers/${provider.id}/package-purchases`}>
            Paket Geçmişim
          </Link>
          <Link className="btn btn-ghost" href={`/providers/${provider.id}/edit`}>
            Profili Düzenle
          </Link>
          <Link className="btn btn-ghost" href={`/providers/${provider.id}`}>
            Profil önizleme
          </Link>
        </div>
      </section>
    </main>
  );
}

function ProviderStatusNotice({ provider }: { provider: NonNullable<ProviderDashboard['provider']> }) {
  if (provider.status === 'PENDING_REVIEW') {
    return (
      <div className="notice" style={{ marginBottom: 18 }}>
        Başvurunuz inceleniyor. Onaylandıktan sonra uygun taleplere teklif verebilirsiniz.
      </div>
    );
  }

  if (provider.status === 'REJECTED') {
    return (
      <div className="notice-error" style={{ marginBottom: 18 }}>
        Başvurunuz reddedildi. Sebep: {provider.rejectionReason ?? '-'}
      </div>
    );
  }

  if (provider.status === 'SUSPENDED') {
    return (
      <div className="notice-warning" style={{ marginBottom: 18 }}>
        Profiliniz askıya alındı. Bu durumda teklif akışı kullanılamaz.
      </div>
    );
  }

  return null;
}

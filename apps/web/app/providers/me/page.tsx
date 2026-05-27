import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, getCurrentUser, ProviderDashboard, statusLabel } from '../../../lib/api';

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
        <p className="nav-links">
          <Link href="/">Ana sayfa</Link>
        </p>
        <h1>Hizmet Veren Paneli</h1>
        <div className="empty-state">
          <h2>Henüz hizmet veren profiliniz yok</h2>
          <p>Talep eşleşmelerini ve teklif akışını kullanmak için önce profil oluşturun.</p>
          <Link className="button" href="/providers/register">
            Hizmet veren profili oluştur
          </Link>
        </div>
      </main>
    );
  }

  const canUseOfferFlow = provider.status === 'APPROVED';

  return (
    <main>
      <p className="nav-links">
        <Link href="/">Ana sayfa</Link>
        <Link href={`/providers/${provider.id}`}>Profil önizleme</Link>
      </p>
      <h1>Hizmet Veren Paneli</h1>

      <section className="notice">
        <h2>{provider.businessName}</h2>
        <p>
          Durum: <span className={badgeClass(provider.status)}>{statusLabel(provider.status)}</span>
        </p>
        <p>Bağlı hesap: {provider.user?.email ?? user.email ?? '-'}</p>
        <p>
          Hizmet bölgesi: {provider.city}/{provider.district}
        </p>
        <ProviderStatusNotice provider={provider} />
      </section>

      <section className="summary-grid">
        <div className="summary-card">
          <p className="muted">Kredi bakiyesi</p>
          <p className="metric">{dashboard.creditBalance ?? 0}</p>
        </div>
        <div className="summary-card">
          <p className="muted">Aktif teklifler</p>
          <p className="metric">{dashboard.activeOffersCount ?? 0}</p>
        </div>
        <div className="summary-card">
          <p className="muted">Toplam teklif</p>
          <p className="metric">{dashboard.recentOffersCount ?? 0}</p>
        </div>
        <div className="summary-card">
          <p className="muted">Uygun onaylı talep</p>
          <p className="metric">{dashboard.matchingApprovedRequestsCount ?? 0}</p>
        </div>
      </section>

      <section>
        <h2>Hızlı işlemler</h2>
        <p className="actions">
          {canUseOfferFlow ? (
            <Link className="button" href={`/providers/${provider.id}/requests`}>
              Uygun Talepler
            </Link>
          ) : null}
          <Link className="button" href={`/providers/${provider.id}/offers`}>
            Tekliflerim
          </Link>
          <Link className="button" href={`/providers/${provider.id}/credits`}>
            Kredilerim
          </Link>
          <Link className="button" href={`/providers/${provider.id}/edit`}>
            Profilimi Düzenle
          </Link>
        </p>
      </section>
    </main>
  );
}

function ProviderStatusNotice({ provider }: { provider: NonNullable<ProviderDashboard['provider']> }) {
  if (provider.status === 'PENDING_REVIEW') {
    return <p className="notice">Başvurunuz inceleniyor. Onaylandıktan sonra uygun taleplere teklif verebilirsiniz.</p>;
  }

  if (provider.status === 'REJECTED') {
    return <p className="notice">Başvurunuz reddedildi. Sebep: {provider.rejectionReason ?? '-'}</p>;
  }

  if (provider.status === 'SUSPENDED') {
    return <p className="notice">Profiliniz askıya alındı. Bu durumda teklif akışı kullanılamaz.</p>;
  }

  return null;
}

function badgeClass(status: string) {
  if (status === 'APPROVED') {
    return 'badge badge-good';
  }

  if (status === 'PENDING_REVIEW') {
    return 'badge badge-warn';
  }

  if (status === 'REJECTED' || status === 'SUSPENDED') {
    return 'badge badge-bad';
  }

  return 'badge';
}

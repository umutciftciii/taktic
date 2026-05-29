import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  apiFetch,
  getCurrentUser,
  ProviderDashboard,
  statusLabel,
} from '../../../lib/api';
import { ProviderShell } from '../provider-shell';
import { providerStatusBadgeClass } from '../provider-ui';

export default async function MyProviderPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'PROVIDER') {
    redirect('/login?redirectTo=/providers/me');
  }

  const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
  const provider = dashboard.provider;

  if (!provider) {
    return (
      <ProviderShell user={user} active="dashboard">
        <header className="pdash-page-head">
          <h1 className="pdash-page-title">Hizmet Veren Paneli</h1>
          <p className="pdash-page-sub">
            Talep eşleşmelerini ve teklif akışını kullanmak için önce profilinizi tamamlayın.
          </p>
        </header>

        <div className="pdash-empty">
          <h3>Henüz hizmet veren profiliniz yok</h3>
          <p>
            Eşleşen talepleri görmek ve teklif vermek için hizmet veren profilinizi oluşturmanız gerekiyor.
          </p>
          <Link className="pdash-btn pdash-btn-primary" href="/providers/register">
            Hizmet Veren Profili Oluştur
          </Link>
        </div>
      </ProviderShell>
    );
  }

  const canUseOfferFlow = provider.status === 'APPROVED';
  const creditBalance = dashboard.creditBalance ?? 0;
  const activeOffers = dashboard.activeOffersCount ?? 0;
  const totalOffers = dashboard.recentOffersCount ?? 0;
  const matchingRequests = dashboard.matchingApprovedRequestsCount ?? 0;

  return (
    <ProviderShell user={user} providerId={provider.id} businessName={provider.businessName} active="dashboard">
      <header className="pdash-page-head">
        <h1 className="pdash-page-title">{provider.businessName}</h1>
        <p className="pdash-page-sub">
          <span className={providerStatusBadgeClass(provider.status)}>{statusLabel(provider.status)}</span>
          <span style={{ marginLeft: 8 }}>· {provider.city}/{provider.district}</span>
        </p>
      </header>

      <ProviderStatusNotice provider={provider} />

      <section className="pdash-stat-grid" aria-label="Özet">
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Kredi Bakiyesi</span>
          <span className="pdash-stat-value">{creditBalance}</span>
          <span className="pdash-stat-hint">Her teklif 1 kredi kullanır</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Uygun Onaylı Talep</span>
          <span className="pdash-stat-value">{matchingRequests}</span>
          <span className="pdash-stat-hint">Hizmet bölgenize uyan açık talep</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Aktif Teklif</span>
          <span className="pdash-stat-value">{activeOffers}</span>
          <span className="pdash-stat-hint">Henüz sonuçlanmamış teklifler</span>
        </div>
        <div className="pdash-stat-card">
          <span className="pdash-stat-label">Toplam Teklif</span>
          <span className="pdash-stat-value">{totalOffers}</span>
          <span className="pdash-stat-hint">Son dönemde verdiğiniz teklifler</span>
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="Hızlı işlemler">
        <div className="pdash-section-head">
          <h2 className="pdash-section-title">Hızlı işlemler</h2>
        </div>
        <div className="pdash-grid">
          <QuickActionCard
            title="Uygun Talepler"
            description="Hizmet bölgenize ve kategorinize uyan açık talepleri görüntüleyin."
            href={`/providers/${provider.id}/requests`}
            cta={canUseOfferFlow ? 'Talepleri Gör' : 'Sadece görüntüle'}
            disabled={!canUseOfferFlow}
          />
          <QuickActionCard
            title="Tekliflerim"
            description="Gönderdiğiniz teklifleri ve durumlarını izleyin."
            href={`/providers/${provider.id}/offers`}
            cta="Teklifleri Aç"
          />
          <QuickActionCard
            title="Kredilerim"
            description="Mevcut kredi bakiyesi ve kredi işlemleri."
            href={`/providers/${provider.id}/credits`}
            cta="Kredileri Aç"
          />
          <QuickActionCard
            title="Profilim"
            description="İşletme bilgilerinizi ve hizmet kapsamınızı yönetin."
            href={`/providers/${provider.id}`}
            cta="Profili Aç"
          />
        </div>
      </section>
    </ProviderShell>
  );
}

type QuickActionCardProps = {
  title: string;
  description: string;
  href: string;
  cta: string;
  disabled?: boolean;
};

function QuickActionCard({ title, description, href, cta, disabled }: QuickActionCardProps) {
  return (
    <article className="pdash-card">
      <div>
        <h3 className="pdash-card-title">{title}</h3>
        <p className="pdash-card-sub" style={{ marginTop: 6, fontSize: 13 }}>
          {description}
        </p>
      </div>
      <div className="pdash-card-foot">
        <span />
        {disabled ? (
          <span className="pdash-btn pdash-btn-secondary pdash-btn-sm" aria-disabled="true" title="Profil onaylanınca aktifleşir">
            {cta}
          </span>
        ) : (
          <Link className="pdash-btn pdash-btn-primary pdash-btn-sm" href={href}>
            {cta}
          </Link>
        )}
      </div>
    </article>
  );
}

function ProviderStatusNotice({ provider }: { provider: NonNullable<ProviderDashboard['provider']> }) {
  if (provider.status === 'PENDING_REVIEW') {
    return (
      <div className="pdash-notice">
        Başvurunuz inceleniyor. Onaylandıktan sonra uygun taleplere teklif verebilirsiniz.
      </div>
    );
  }

  if (provider.status === 'REJECTED') {
    return (
      <div className="pdash-notice pdash-notice-error">
        Başvurunuz reddedildi. Sebep: {provider.rejectionReason ?? '-'}
      </div>
    );
  }

  if (provider.status === 'SUSPENDED') {
    return (
      <div className="pdash-notice pdash-notice-warn">
        Profiliniz askıya alındı. Bu durumda teklif akışı kullanılamaz.
      </div>
    );
  }

  return null;
}

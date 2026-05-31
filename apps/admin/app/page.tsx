import Link from 'next/link';
import { AdminSummary, apiFetch, requireAdmin } from '../lib/api';
import { PageHeader } from '../components/page-header';
import { SectionCard } from '../components/section-card';
import { StatCard } from '../components/stat-card';

export default async function AdminHomePage() {
  const user = await requireAdmin();
  const summary = await apiFetch<AdminSummary>('/dashboard/admin-summary');

  return (
    <main>
      <PageHeader
        title="TakTic Admin"
        subtitle={
          <>
            Yönetim paneli · giriş yapan: <strong>{user.email}</strong>
          </>
        }
      />

      <section className="stat-grid">
        <StatCard label="Toplam talep" value={summary.totalRequests} href="/requests" />
        <StatCard label="Bekleyen talepler" value={summary.pendingRequests} href="/requests" tone="warning" />
        <StatCard label="İncelemedeki talepler" value={summary.inReviewRequests} href="/requests" tone="warning" />
        <StatCard label="Onaylı hizmet verenler" value={summary.approvedProviders} href="/providers" tone="success" />
        <StatCard label="Bekleyen hizmet verenler" value={summary.pendingProviders} href="/providers" tone="warning" />
        <StatCard label="Toplam teklif" value={summary.totalOffers} href="/offers" />
        <StatCard label="İade adayı" value={summary.refundableOffers} href="/refund-scan" tone="warning" />
        <StatCard label="Paket talebi" value={summary.packagePurchases} href="/package-purchases" />
      </section>

      <SectionCard title="Hızlı işlemler" subtitle="Sık kullanılan operasyon ve katalog ekranlarına git.">
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" href="/requests">Talepleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/providers">Hizmet verenleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/offers">Teklifleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/categories">Kategorileri yönet</Link>
          <Link className="btn btn-secondary btn-sm" href="/credit-packages">Kredi paketleri</Link>
          <Link className="btn btn-secondary btn-sm" href="/package-purchases">Paket satın almaları</Link>
          <Link className="btn btn-ghost btn-sm" href="/refund-scan">İade taraması</Link>
        </div>
      </SectionCard>
    </main>
  );
}

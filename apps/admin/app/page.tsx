import Link from 'next/link';
import { AdminSummary, apiFetch, requireAdmin } from '../lib/api';

export default async function AdminHomePage() {
  const user = await requireAdmin();
  const summary = await apiFetch<AdminSummary>('/dashboard/admin-summary');

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">TakTic Admin</h1>
        <p className="page-subtitle">Yönetim paneli · giriş yapan: <strong>{user.email}</strong></p>
      </header>

      <section className="stat-grid">
        <SummaryCard label="Toplam talep" value={summary.totalRequests} href="/requests" />
        <SummaryCard label="Bekleyen talepler" value={summary.pendingRequests} href="/requests" tone="warning" />
        <SummaryCard label="İncelemedeki talepler" value={summary.inReviewRequests} href="/requests" tone="warning" />
        <SummaryCard label="Onaylı hizmet verenler" value={summary.approvedProviders} href="/providers" tone="success" />
        <SummaryCard label="Bekleyen hizmet verenler" value={summary.pendingProviders} href="/providers" tone="warning" />
        <SummaryCard label="Toplam teklif" value={summary.totalOffers} href="/offers" />
        <SummaryCard label="İade adayı" value={summary.refundableOffers} href="/refund-scan" tone="warning" />
        <SummaryCard label="Paket talebi" value={summary.packagePurchases} href="/package-purchases" />
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Hızlı işlemler</h2>
        <div className="inline-actions">
          <Link className="btn btn-primary btn-sm" href="/requests">Talepleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/providers">Hizmet verenleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/offers">Teklifleri incele</Link>
          <Link className="btn btn-secondary btn-sm" href="/categories">Kategorileri yönet</Link>
          <Link className="btn btn-secondary btn-sm" href="/credit-packages">Kredi paketleri</Link>
          <Link className="btn btn-secondary btn-sm" href="/package-purchases">Paket talepleri</Link>
          <Link className="btn btn-ghost btn-sm" href="/refund-scan">İade taraması</Link>
        </div>
      </section>
    </main>
  );
}

function SummaryCard({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone?: 'success' | 'warning' | 'error';
}) {
  return (
    <Link className="summary-card" href={href}>
      <span className="muted">{label}</span>
      <span className="metric">{value}</span>
      {tone ? (
        <span className={`badge badge-${tone === 'success' ? 'good' : tone === 'warning' ? 'warn' : 'bad'}`}>
          {tone === 'success' ? 'iyi' : tone === 'warning' ? 'dikkat' : 'uyarı'}
        </span>
      ) : null}
    </Link>
  );
}

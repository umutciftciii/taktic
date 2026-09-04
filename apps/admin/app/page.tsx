import Link from 'next/link';
import { AdminSummary, apiFetch, requireAdmin } from '../lib/api';
import { PageHeader } from '../components/page-header';
import { SectionCard } from '../components/section-card';
import { StatCard } from '../components/stat-card';
import { buildAdminDashboardMetrics } from '../lib/dashboard-metrics';

export default async function AdminHomePage() {
  const user = await requireAdmin();
  const summary = await apiFetch<AdminSummary>('/dashboard/admin-summary');
  const metrics = buildAdminDashboardMetrics(summary);

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
        {/*
          Every card, its number and its badge come from one place. The page
          used to type `tone="warning"` onto each card, which is how an empty
          marketplace ended up wearing a "dikkat" badge on three zeroes — see
          lib/dashboard-metrics.ts for the rule that replaced it.
        */}
        {metrics.map((metric) => (
          <StatCard
            key={metric.key}
            metricKey={metric.key}
            label={metric.label}
            value={metric.value}
            href={metric.href}
            tone={metric.tone}
          />
        ))}
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
          <Link className="btn btn-ghost btn-sm" href="/support">Destek talepleri</Link>
        </div>
      </SectionCard>
    </main>
  );
}

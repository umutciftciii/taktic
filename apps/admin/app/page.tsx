import Link from 'next/link';
import { AdminSummary, apiFetch, requireAdmin } from '../lib/api';
import { PageHeader } from '../components/page-header';
import { SectionCard } from '../components/section-card';
import { StatCard } from '../components/stat-card';
import { buildAdminDashboardMetrics } from '../lib/dashboard-metrics';

/**
 * The permission each destination page asks for in its own `requireAdmin`.
 *
 * The numbers are all covered by DASHBOARD_READ; following one into its list is
 * not. A card or a quick link whose page would answer /yetkisiz is not a link.
 * Longest prefix first, so `/requests/reports` is not read as `/requests`. An
 * unknown destination is not linked — a new card has to be added here.
 */
const DESTINATION_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ['/requests/reports', 'REQUEST_REPORTS_READ'],
  ['/requests', 'REQUESTS_READ'],
  ['/providers', 'PROVIDERS_READ'],
  ['/offers', 'OFFERS_READ'],
  ['/categories', 'CATALOG_READ'],
  ['/credit-packages', 'CREDIT_PACKAGES_READ'],
  ['/package-purchases', 'PACKAGE_PURCHASES_READ'],
  ['/refund-scan', 'OFFER_REFUND_SCAN_READ'],
  ['/support', 'SUPPORT_READ'],
];

function destinationPermission(href: string): string | null {
  const path = href.split(/[?#]/, 1)[0] ?? href;
  const match = DESTINATION_PERMISSIONS.find(
    ([prefix]) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return match ? match[1] : null;
}

const QUICK_LINKS: ReadonlyArray<{ href: string; label: string; className: string }> = [
  { href: '/requests', label: 'Talepleri incele', className: 'btn btn-primary btn-sm' },
  { href: '/providers', label: 'Hizmet verenleri incele', className: 'btn btn-secondary btn-sm' },
  { href: '/offers', label: 'Teklifleri incele', className: 'btn btn-secondary btn-sm' },
  { href: '/categories', label: 'Kategorileri yönet', className: 'btn btn-secondary btn-sm' },
  { href: '/credit-packages', label: 'Kredi paketleri', className: 'btn btn-secondary btn-sm' },
  { href: '/package-purchases', label: 'Paket satın almaları', className: 'btn btn-secondary btn-sm' },
  { href: '/refund-scan', label: 'İade taraması', className: 'btn btn-ghost btn-sm' },
  { href: '/support', label: 'Destek talepleri', className: 'btn btn-ghost btn-sm' },
];

export default async function AdminHomePage() {
  const { user, can } = await requireAdmin('DASHBOARD_READ');
  const canOpen = (href: string) => {
    const permission = destinationPermission(href);
    return permission !== null && can(permission);
  };
  const quickLinks = QUICK_LINKS.filter((link) => canOpen(link.href));
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
            href={canOpen(metric.href) ? metric.href : undefined}
            tone={metric.tone}
          />
        ))}
      </section>

      {quickLinks.length > 0 ? (
        <SectionCard title="Hızlı işlemler" subtitle="Sık kullanılan operasyon ve katalog ekranlarına git.">
          <div className="inline-actions">
            {quickLinks.map((link) => (
              <Link key={link.href} className={link.className} href={link.href}>
                {link.label}
              </Link>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </main>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AdminSummary,
  apiFetch,
  CampaignEngineSettings,
  formatDateTime,
  MarketplacePublishSettings,
  OperationsSettings,
  ProviderReviewSettings,
  readAdminAccess,
  requireAdmin,
  SchedulerSettings,
} from '../lib/api';
import { PageHeader } from '../components/page-header';
import { DashboardKpis, DashboardQueues, DashboardSystemActivity } from '../components/dashboard-overview';
import { buildAdminDashboardMetrics } from '../lib/dashboard-metrics';
import {
  buildDashboardKpis,
  buildDashboardQueues,
  buildSystemActivity,
  dashboardGreeting,
  linkIfAllowed,
  type OperationsSnapshot,
} from '../lib/dashboard-overview';
import { filterNavMenu } from '../lib/nav';

/**
 * Genel görünüm (#1), design `dashboard` (ADMIN-DESIGN-001 Faz 3H).
 *
 * Greeting, "Önce bunlara bak", four headline figures and — for a session that
 * may read the operations settings — "Sistem şu anda ne yapıyor". What each
 * block shows, links and colours is decided in `lib/dashboard-overview.ts` on
 * top of `lib/dashboard-metrics.ts`; see there for K2 (a queue only for a
 * session that may open it) and K12 (no figure without a source: no change
 * figures, sparklines, 7-day chart or "son yapılanlar" feed).
 */

export const dynamic = 'force-dynamic';

async function readOperations(): Promise<OperationsSnapshot> {
  const [settings, schedulers, publish, reviews, engine] = await Promise.all([
    apiFetch<OperationsSettings>('/operations-settings'),
    apiFetch<SchedulerSettings>('/operations-settings/schedulers'),
    apiFetch<MarketplacePublishSettings>('/operations-settings/marketplace-publish'),
    apiFetch<ProviderReviewSettings>('/operations-settings/provider-reviews'),
    apiFetch<CampaignEngineSettings>('/operations-settings/campaign-engine'),
  ]);
  return { settings, schedulers, publish, reviews, engine };
}

export default async function AdminHomePage() {
  // `/` is where signing in, the brand mark and /yetkisiz's "Panele dön" all
  // lead. A role without the dashboard is sent to the first row its menu
  // holds instead of to /yetkisiz — which used to be a loop, since
  // "Panele dön" came straight back here (Faz 4). A session whose menu is
  // empty has nowhere to go and is refused below as before; no session at
  // all (`null`) is `requireAdmin`'s to send to the sign-in form.
  const access = await readAdminAccess();
  if (access && !access.isSuperAdmin && !access.permissions.includes('DASHBOARD_READ')) {
    const held = new Set(access.permissions);
    const menu = filterNavMenu((permission) => held.has(permission), false);
    const first = menu.groups[0]?.items[0]?.href;
    if (first) redirect(first);
  }

  const { user, can } = await requireAdmin('DASHBOARD_READ');
  const canReadOperations = can('OPERATIONS_SETTINGS_READ');

  // One after the other, not together: the summary is ten parallel counts and
  // the settings reads are five requests of their own. Started at once they
  // doubled the connections one page view asks the API's pool for, and on a
  // shared database that is the difference between a slow page and a
  // "too many clients" error screen.
  const summary = await apiFetch<AdminSummary>('/dashboard/admin-summary');
  const operations = canReadOperations ? await readOperations() : null;

  const metrics = buildAdminDashboardMetrics(summary);
  const queues = buildDashboardQueues(metrics, can);
  const kpis = buildDashboardKpis(metrics, can);
  const activity = operations ? buildSystemActivity(operations, formatDateTime) : null;
  const greeting = dashboardGreeting(user.name, new Date());

  const requestsHref = linkIfAllowed('/requests', can);
  const settingsHref = linkIfAllowed('/operations-settings', can);

  return (
    <main className="dashboard-page">
      <PageHeader
        title={greeting.title}
        subtitle={
          <>
            <time dateTime={greeting.isoDate} data-testid="dashboard-date">
              {greeting.date}
            </time>
            {queues.length > 0
              ? '. Bekleyen işler aşağıda; her kutu kendi listesini aynı filtreyle açar.'
              : '.'}
          </>
        }
        actions={
          requestsHref || settingsHref ? (
            <>
              {requestsHref ? (
                <Link className="btn btn-primary" href={requestsHref}>
                  Talepleri incele
                </Link>
              ) : null}
              {settingsHref ? (
                <Link className="btn btn-secondary" href={settingsHref}>
                  Operasyon ayarları
                </Link>
              ) : null}
            </>
          ) : undefined
        }
      />

      {queues.length > 0 ? <DashboardQueues cells={queues} /> : null}

      <DashboardKpis kpis={kpis} />

      {activity && settingsHref ? <DashboardSystemActivity rows={activity} settingsHref={settingsHref} /> : null}
    </main>
  );
}

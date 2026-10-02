import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardKpis, DashboardQueues, DashboardSystemActivity } from '../components/dashboard-overview';
import type { AdminSummary, SchedulerJob } from '../lib/api';
import { buildAdminDashboardMetrics } from '../lib/dashboard-metrics';
import {
  buildDashboardKpis,
  buildDashboardQueues,
  buildSystemActivity,
  dashboardGreeting,
  destinationPermission,
  type OperationsSnapshot,
} from '../lib/dashboard-overview';

/**
 * ADMIN-DESIGN-001 Faz 3H — Genel görünüm.
 *
 * Pinned here: a queue cell exists only for a session that may open its list
 * (K2) and opens it on the filter the number counts; a zero is a plain zero;
 * the four headline figures and their notes come from the summary alone; the
 * greeting uses the account's name and Istanbul's clock; "Sistem şu anda ne
 * yapıyor" is the operations settings reads and nothing more; and the design
 * elements with no source (K12) are not on the page.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

const EMPTY: AdminSummary = {
  totalRequests: 0,
  pendingRequests: 0,
  inReviewRequests: 0,
  approvedProviders: 0,
  pendingProviders: 0,
  totalOffers: 0,
  refundableOffers: 0,
  packagePurchases: 0,
  openSupportTickets: 0,
  openRequestReports: 0,
  reportedRequests: 0,
  pendingShowcaseReviews: 0,
};

const BUSY: AdminSummary = {
  totalRequests: 148,
  pendingRequests: 4,
  inReviewRequests: 2,
  approvedProviders: 284,
  pendingProviders: 5,
  totalOffers: 1392,
  refundableOffers: 3,
  packagePurchases: 37,
  openSupportTickets: 2,
  // Three reports on two requests: the cell counts requests.
  openRequestReports: 3,
  reportedRequests: 2,
  pendingShowcaseReviews: 1,
};

const everything = () => true;
const nothing = () => false;
const only = (...held: string[]) => (permission: string) => held.includes(permission);

describe('Önce bunlara bak: K2', () => {
  it('draws başvuru, şikayet, destek and vitrin for a session that may open all four, in that order', () => {
    const cells = buildDashboardQueues(buildAdminDashboardMetrics(BUSY), everything);
    expect(cells.map((cell) => [cell.metricKey, cell.value, cell.href])).toEqual([
      ['pendingProviders', 5, '/providers?status=PENDING_REVIEW'],
      ['reportedRequests', 2, '/requests/reports?state=open'],
      ['openSupportTickets', 2, '/support?status=OPEN,IN_PROGRESS'],
      ['pendingShowcaseReviews', 1, '/showcase/reviews'],
    ]);
    expect(cells.map((cell) => cell.kicker)).toEqual(['Başvuru', 'Şikayet', 'Destek', 'Vitrin']);
    // The report cell counts requests, not reports (API-DASHBOARD-REQUEST-REPORT-COUNT-001).
    expect(cells[1]!.title).toBe('Karar bekleyen şikayetli talep');
  });

  it('draws no cell for a queue count the API left out, whatever the session holds', () => {
    const { reportedRequests: _r, pendingShowcaseReviews: _p, ...withheld } = BUSY;
    const cells = buildDashboardQueues(buildAdminDashboardMetrics(withheld), everything);
    expect(cells.map((cell) => cell.metricKey)).toEqual(['pendingProviders', 'openSupportTickets']);
  });

  it.each([
    ['PROVIDERS_READ', 'pendingProviders'],
    ['REQUEST_REPORTS_READ', 'reportedRequests'],
    ['SUPPORT_READ', 'openSupportTickets'],
    ['SHOWCASE_REVIEW_READ', 'pendingShowcaseReviews'],
  ])('with only %s, only its cell', (permission, key) => {
    const cells = buildDashboardQueues(buildAdminDashboardMetrics(BUSY), only(permission));
    expect(cells.map((cell) => cell.metricKey)).toEqual([key]);
  });

  it('draws no cell — and so no card — for DASHBOARD_READ alone', () => {
    expect(buildDashboardQueues(buildAdminDashboardMetrics(BUSY), only('DASHBOARD_READ'))).toEqual([]);
    expect(buildDashboardQueues(buildAdminDashboardMetrics(BUSY), nothing)).toEqual([]);
  });

  it('does not open the report queue on REQUESTS_READ: the longer prefix wins', () => {
    expect(destinationPermission('/requests/reports?state=open')).toBe('REQUEST_REPORTS_READ');
    expect(buildDashboardQueues(buildAdminDashboardMetrics(BUSY), only('REQUESTS_READ'))).toEqual([]);
  });

  it('shows 0 as 0, uncoloured, and a positive count with the metric tone', () => {
    const quiet = buildDashboardQueues(buildAdminDashboardMetrics(EMPTY), everything);
    expect(quiet.map((cell) => [cell.value, cell.tone])).toEqual([
      [0, 'neutral'],
      [0, 'neutral'],
      [0, 'neutral'],
      [0, 'neutral'],
    ]);
    const busy = buildDashboardQueues(buildAdminDashboardMetrics(BUSY), everything);
    expect(busy.every((cell) => cell.tone === 'warning')).toBe(true);

    const markup = html(<DashboardQueues cells={quiet} />);
    expect(markup.match(/data-testid="dashboard-queue"/g)).toHaveLength(4);
    expect(markup.match(/data-tone="neutral"/g)).toHaveLength(4);
    expect(markup).not.toContain('data-tone="warning"');
    expect(markup.match(/data-testid="dashboard-queue-value">0</g)).toHaveLength(4);
    expect(markup).not.toMatch(/dikkat/i);
  });

  it('renders each cell as one link to its filter, with no "güncellendi" claim', () => {
    const markup = html(<DashboardQueues cells={buildDashboardQueues(buildAdminDashboardMetrics(BUSY), everything)} />);
    expect(markup).toContain('href="/providers?status=PENDING_REVIEW"');
    expect(markup).toContain('href="/requests/reports?state=open"');
    expect(markup).toContain('href="/support?status=OPEN,IN_PROGRESS"');
    expect(markup).toContain('href="/showcase/reviews"');
    expect(markup).toContain('aria-labelledby="dashboard-queues-title"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toMatch(/önce güncellendi/);
  });
});

describe('the four headline figures', () => {
  it('are requests, offers, approved providers and package purchases, straight from the summary', () => {
    const kpis = buildDashboardKpis(buildAdminDashboardMetrics(BUSY), everything);
    expect(kpis.map((kpi) => [kpi.metricKey, kpi.label, kpi.value, kpi.href])).toEqual([
      ['totalRequests', 'Toplam talep', 148, '/requests'],
      ['totalOffers', 'Toplam teklif', 1392, '/offers'],
      ['approvedProviders', 'Onaylı hizmet veren', 284, '/providers?status=APPROVED'],
      ['packagePurchases', 'Paket satın alma', 37, '/package-purchases'],
    ]);
  });

  it('carry the remaining action counts as notes linked to their exact view, toned by the badge rule', () => {
    const [requests, offers] = buildDashboardKpis(buildAdminDashboardMetrics(BUSY), everything);
    expect(requests!.notes.map((note) => [note.metricKey, note.value, note.href, note.tone])).toEqual([
      ['pendingRequests', 4, '/requests?status=SUBMITTED', 'warning'],
      ['inReviewRequests', 2, '/requests?status=IN_REVIEW', 'warning'],
    ]);
    expect(offers!.notes.map((note) => [note.metricKey, note.value, note.href, note.tone])).toEqual([
      ['refundableOffers', 3, '/refund-scan', 'warning'],
    ]);

    const quiet = buildDashboardKpis(buildAdminDashboardMetrics(EMPTY), everything);
    expect(quiet.flatMap((kpi) => kpi.notes).every((note) => note.value === 0 && note.tone === 'neutral')).toBe(true);
  });

  it('are numbers without links for a session that may open none of the lists', () => {
    const kpis = buildDashboardKpis(buildAdminDashboardMetrics(BUSY), only('DASHBOARD_READ'));
    expect(kpis.every((kpi) => kpi.href === null && kpi.notes.every((note) => note.href === null))).toBe(true);

    const markup = html(<DashboardKpis kpis={kpis} />);
    expect(markup).not.toContain('<a ');
    expect(markup).toContain('>1.392<');
    expect(markup.match(/data-testid="dashboard-kpi"/g)).toHaveLength(4);
  });

  it('draw no change figure, sparkline or chart', () => {
    const markup = html(<DashboardKpis kpis={buildDashboardKpis(buildAdminDashboardMetrics(BUSY), everything)} />);
    expect(markup).not.toMatch(/<svg|polyline|%|Geçen hafta|Bu hafta/);
    expect(markup).not.toMatch(/dikkat/);
  });
});

describe('the greeting', () => {
  it('uses the first word of the account name and Istanbul’s hour and date', () => {
    // 06:30 UTC is 09:30 in Istanbul.
    expect(dashboardGreeting('Umut Çiftci', new Date('2026-09-30T06:30:00Z'))).toEqual({
      title: 'Günaydın, Umut',
      date: '30 Eylül, Çarşamba',
      isoDate: '2026-09-30',
    });
    expect(dashboardGreeting('Seda', new Date('2026-09-30T11:00:00Z')).title).toBe('İyi günler, Seda');
    expect(dashboardGreeting('Seda', new Date('2026-09-30T16:00:00Z')).title).toBe('İyi akşamlar, Seda');
    // 22:30 UTC on the 30th is 01:30 on 1 October in Istanbul.
    const late = dashboardGreeting('Seda', new Date('2026-09-30T22:30:00Z'));
    expect(late).toMatchObject({ title: 'İyi geceler, Seda', date: '1 Ekim, Perşembe', isoDate: '2026-10-01' });
  });

  it('greets an account with no name without inventing one', () => {
    expect(dashboardGreeting(null, new Date('2026-09-30T06:30:00Z')).title).toBe('Günaydın');
    expect(dashboardGreeting('   ', new Date('2026-09-30T06:30:00Z')).title).toBe('Günaydın');
  });
});

function job(key: SchedulerJob['key'], enabled: boolean, lastRun: SchedulerJob['lastRun'] = null): SchedulerJob {
  return { key, enabled, cron: '0 * * * *', movesMoney: false, lastRun };
}

const SNAPSHOT: OperationsSnapshot = {
  settings: {
    configured: true,
    unviewedOfferRefundWindowHours: 48,
    minUnviewedOfferRefundWindowHours: 1,
    maxUnviewedOfferRefundWindowHours: 720,
    defaultUnviewedOfferRefundWindowHours: 48,
    unviewedOfferRefundNotice: '',
    updatedAt: null,
    updatedBy: null,
    recentChanges: [],
  },
  schedulers: {
    jobs: [
      job('unviewed-offer-refund', true, {
        id: 'run-1',
        status: 'SUCCESS',
        trigger: 'SCHEDULER',
        startedAt: '2026-09-30T06:00:00.000Z',
        finishedAt: '2026-09-30T06:00:02.000Z',
        summary: null,
        errorCode: null,
      }),
      job('request-expiry', false),
      job('request-reminder', true, {
        id: 'run-2',
        status: 'FAILED',
        trigger: 'SCHEDULER',
        startedAt: '2026-09-30T06:00:00.000Z',
        finishedAt: '2026-09-30T06:00:01.000Z',
        summary: null,
        errorCode: 'TypeError',
      }),
    ],
    recentChanges: [],
  },
  publish: { enabled: true, recentChanges: [] },
  reviews: { enabled: false, recentChanges: [] },
  engine: { enabled: false, recentChanges: [] },
};

describe('Sistem şu anda ne yapıyor', () => {
  const rows = buildSystemActivity(SNAPSHOT, (value) => `T(${value})`);

  it('is the three switches, the refund window and every job the API listed, as stored', () => {
    expect(rows.map((row) => [row.key, row.state, row.tone])).toEqual([
      ['auto-publish', 'Açık', 'on'],
      ['campaign-engine', 'Kapalı', 'off'],
      ['provider-reviews', 'Kapalı', 'off'],
      ['offer-refund-window', '48 saat', 'value'],
      ['job-unviewed-offer-refund', 'Açık', 'on'],
      ['job-request-expiry', 'Kapalı', 'off'],
      ['job-request-reminder', 'Son çalışma hata', 'failed'],
    ]);
  });

  it('writes a second line only from a recorded run, never an invented time', () => {
    expect(rows.find((row) => row.key === 'job-unviewed-offer-refund')!.detail).toBe(
      'Son çalışma T(2026-09-30T06:00:02.000Z) · tamamlandı',
    );
    expect(rows.find((row) => row.key === 'job-request-reminder')!.detail).toBe(
      'Son çalışma T(2026-09-30T06:00:01.000Z) · hata verdi (TypeError)',
    );
    expect(rows.find((row) => row.key === 'job-request-expiry')!.detail).toBeNull();
    expect(rows.find((row) => row.key === 'auto-publish')!.detail).toBeNull();
  });

  it('says so when the refund window is the unsaved default', () => {
    const fresh = buildSystemActivity(
      { ...SNAPSHOT, settings: { ...SNAPSHOT.settings, configured: false } },
      String,
    );
    expect(fresh.find((row) => row.key === 'offer-refund-window')!.detail).toBe(
      'Varsayılan değer; henüz kaydedilmedi.',
    );
  });

  it('draws "Kapalı" muted and only a failed run in the error colour', () => {
    const markup = html(<DashboardSystemActivity rows={rows} settingsHref="/operations-settings" />);
    expect(markup.match(/badge badge-muted/g)).toHaveLength(3);
    expect(markup.match(/badge badge-bad/g)).toHaveLength(1);
    expect(markup).toContain('href="/operations-settings"');
    expect(markup).not.toMatch(/bildirim gitti|son 24 saat/i);
  });
});

describe('the page', () => {
  const page = read('app/page.tsx');

  it('asks for DASHBOARD_READ and reads the operations settings only with OPERATIONS_SETTINGS_READ', () => {
    expect(page).toContain("requireAdmin('DASHBOARD_READ')");
    expect(page).toContain("can('OPERATIONS_SETTINGS_READ')");
    expect(page).toContain("canReadOperations ? await readOperations() : null");
  });

  it('gates both header actions on the page they open', () => {
    expect(page).toContain("linkIfAllowed('/requests', can)");
    expect(page).toContain("linkIfAllowed('/operations-settings', can)");
    expect(destinationPermission('/operations-settings')).toBe('OPERATIONS_SETTINGS_READ');
  });

  it('renders none of the design elements without a source (K12)', () => {
    for (const absent of ['Son 7 gün', 'Panelde son yapılanlar', 'güncellendi', 'Hızlı işlemler', 'StatCard']) {
      expect(page).not.toContain(absent);
    }
  });
});

describe('a run whose end was never recorded', () => {
  it('says it started and that its end is not on record, and is not drawn as a failure', () => {
    const rows = buildSystemActivity(
      {
        ...SNAPSHOT,
        schedulers: {
          jobs: [
            job('request-expiry', true, {
              id: 'run-3',
              status: 'RUNNING',
              trigger: 'SCHEDULER',
              startedAt: '2026-09-30T06:00:00.000Z',
              finishedAt: null,
              summary: null,
              errorCode: null,
            }),
          ],
          recentChanges: [],
        },
      },
      (value) => `T(${value})`,
    );
    const row = rows.find((entry) => entry.key === 'job-request-expiry')!;
    expect(row.tone).toBe('on');
    expect(row.detail).toBe(
      'Son çalışma T(2026-09-30T06:00:00.000Z) başladı · bitişi kaydedilmedi (sürüyor ya da yarıda kaldı)',
    );
  });
});

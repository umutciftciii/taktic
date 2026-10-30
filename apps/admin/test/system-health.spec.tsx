import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemHealthReport } from '../lib/system-health';

/**
 * ADMIN-SYSTEM-HEALTH-001 — the "Sistem sağlığı" screen.
 *
 * Pinned here: the page asks for OPERATIONS_SETTINGS_READ and nothing else;
 * the e-mail section is drawn only when the API sent it; the API row is the
 * panel's own measurement and a failed report is never drawn healthy; and the
 * screen is read-only — no form, no server action.
 */

const apiMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/system-health',
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, requireAdmin: apiMocks.requireAdmin, apiFetch: apiMocks.apiFetch };
});

const { ApiError } = await import('../lib/api');
const { default: SystemHealthPage } = await import('../app/system-health/page');
const { apiReachability, worstStatus, PROBE_REASON_TEXT, SCHEDULER_REASON_TEXT, EMAIL_REASON_TEXT } = await import(
  '../lib/system-health'
);

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

const NOW = '2026-10-30T12:00:00.000Z';

function report(overrides: Partial<SystemHealthReport> = {}): SystemHealthReport {
  return {
    generatedAt: NOW,
    overall: 'DEGRADED',
    database: { status: 'HEALTHY', reason: 'OK', checkedAt: NOW, latencyMs: 4, appliedMigrations: 107 },
    web: { status: 'HEALTHY', reason: 'OK', checkedAt: NOW, latencyMs: 12, httpStatus: 200 },
    admin: { status: 'UNKNOWN', reason: 'NOT_CONFIGURED', checkedAt: NOW, latencyMs: null, httpStatus: null },
    schedulers: {
      status: 'DEGRADED',
      reason: 'OK',
      checkedAt: NOW,
      jobs: [
        {
          key: 'request-expiry',
          enabled: true,
          switchable: true,
          cron: '15 * * * *',
          status: 'DEGRADED',
          reason: 'LAST_RUN_FAILED',
          missedTicks: 0,
          lastRun: { status: 'FAILED', startedAt: NOW, finishedAt: NOW, errorType: 'DATABASE_ERROR' },
          lastSuccessAt: null,
          last24h: { succeeded: 3, failed: 1 },
        },
        {
          key: 'request-reminder',
          enabled: false,
          switchable: true,
          cron: '45 * * * *',
          status: 'UNKNOWN',
          reason: 'DISABLED',
          missedTicks: 0,
          lastRun: null,
          lastSuccessAt: null,
          last24h: { succeeded: 0, failed: 0 },
        },
      ],
      recentFailures: [{ jobKey: 'request-expiry', errorType: 'DATABASE_ERROR', at: NOW }],
    },
    email: {
      status: 'DEGRADED',
      reason: 'FAILURES',
      checkedAt: NOW,
      windowHours: 24,
      counts: { sent: 9, failed: 1, pending: 2, stuckPending: 0 },
      lastSentAt: NOW,
      recentFailures: [
        { id: 'log_1', template: 'offer-received', errorCode: 'UNKNOWN', errorLabel: 'Bilinmeyen hata', at: NOW },
      ],
    },
    notMeasured: ['EXTERNAL_UPTIME', 'BACKUPS', 'HOST_RESOURCES', 'CAMPAIGN_EVALUATION_WORKER'],
    ...overrides,
  };
}

async function renderPage() {
  return renderToStaticMarkup(await SystemHealthPage());
}

beforeEach(() => {
  apiMocks.requireAdmin.mockReset().mockResolvedValue({ can: () => true, permissions: [], isSuperAdmin: false });
  apiMocks.apiFetch.mockReset();
});

describe('rules shared with the API', () => {
  it('combines worst-first; an empty list is UNKNOWN', () => {
    expect(worstStatus([])).toBe('UNKNOWN');
    expect(worstStatus(['HEALTHY', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(worstStatus(['UNKNOWN', 'DEGRADED'])).toBe('DEGRADED');
    expect(worstStatus(['DEGRADED', 'DOWN'])).toBe('DOWN');
  });

  it('reads the API row from the report fetch', () => {
    expect(apiReachability('ok', 10, NOW).status).toBe('HEALTHY');
    expect(apiReachability('report-failed', 10, NOW).status).toBe('DEGRADED');
    expect(apiReachability('unreachable', 8000, NOW).status).toBe('DOWN');
  });

  it('has Turkish copy for every reason the API can send', () => {
    for (const text of [
      ...Object.values(PROBE_REASON_TEXT),
      ...Object.values(SCHEDULER_REASON_TEXT),
      ...Object.values(EMAIL_REASON_TEXT),
    ]) {
      expect(text.length).toBeGreaterThan(5);
    }
  });
});

describe('the page', () => {
  it('asks for OPERATIONS_SETTINGS_READ only', async () => {
    apiMocks.apiFetch.mockResolvedValue(report());
    await renderPage();
    expect(apiMocks.requireAdmin).toHaveBeenCalledWith('OPERATIONS_SETTINGS_READ');
    expect(apiMocks.apiFetch).toHaveBeenCalledWith('/system-health', expect.objectContaining({ signal: expect.anything() }));
  });

  it('draws every section, the e-mail counts and a link to the failed notification', async () => {
    apiMocks.apiFetch.mockResolvedValue(report());
    const markup = await renderPage();
    expect(markup).toContain('data-testid="system-health-overall" data-status="DEGRADED"');
    expect(markup).toContain('data-testid="system-health-row-api"');
    expect(markup).toContain('Uygulanmış migration: 107.');
    expect(markup).toContain(PROBE_REASON_TEXT.NOT_CONFIGURED);
    expect(markup).toContain('data-testid="system-health-email"');
    expect(markup).toContain('data-metric="email-sent"');
    expect(markup).toContain('href="/notifications/log_1"');
    expect(markup).toContain('Veritabanı hatası');
    // A switched-off job reads "Kapalı", not a health state.
    expect(markup).toMatch(/system-health-job-request-reminder.*?Kapalı/);
    // The scope is said on the screen: internal checks are not uptime.
    expect(markup).toContain('dışarıdan erişebildiği anlamına gelmez');
    expect(markup).toContain('Dışarıdan erişilebilirlik');
  });

  it('draws no e-mail section when the API left the block out', async () => {
    const { email: _omitted, ...withoutEmail } = report();
    apiMocks.apiFetch.mockResolvedValue(withoutEmail);
    const markup = await renderPage();
    expect(markup).not.toContain('data-testid="system-health-email"');
    expect(markup).toContain('data-testid="system-health-email-hidden"');
    expect(markup).not.toContain('/notifications/');
  });

  it('never draws a healthy screen when the report failed', async () => {
    apiMocks.apiFetch.mockRejectedValue(new ApiError(500, '{"statusCode":500}'));
    let markup = await renderPage();
    expect(markup).toContain('data-testid="system-health-unavailable"');
    expect(markup).toMatch(/system-health-row-api.*?data-status="DEGRADED"/);
    expect(markup).not.toContain('data-status="HEALTHY"');

    apiMocks.apiFetch.mockRejectedValue(new TypeError('fetch failed'));
    markup = await renderPage();
    expect(markup).toContain('data-testid="system-health-overall" data-status="DOWN"');
    expect(markup).not.toContain('fetch failed');
  });

  it('folds the API row into the overall state', async () => {
    apiMocks.apiFetch.mockResolvedValue(report({ overall: 'HEALTHY' }));
    const markup = await renderPage();
    expect(markup).toContain('data-testid="system-health-overall" data-status="HEALTHY"');
  });

  it('is read-only: no form, no server action, no write call', () => {
    const page = read('app/system-health/page.tsx');
    const refresh = read('app/system-health/health-refresh.tsx');
    for (const source of [page, refresh]) {
      expect(source).not.toMatch(/<form|use server|method: '(POST|PUT|PATCH|DELETE)'/);
    }
    expect(refresh).toContain('router.refresh()');
  });

  it('sits in the sidebar behind the same permission', () => {
    expect(read('lib/nav.ts')).toContain(
      "{ href: '/system-health', label: 'Sistem sağlığı', permission: 'OPERATIONS_SETTINGS_READ' }",
    );
  });
});

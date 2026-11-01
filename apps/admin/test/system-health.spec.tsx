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
const {
  apiReachability,
  worstStatus,
  jobState,
  schedulerSummaryLabel,
  PROBE_REASON_TEXT,
  SCHEDULER_REASON_TEXT,
  EMAIL_REASON_TEXT,
  OPS_ALERT_ENGINE_REASON_TEXT,
} = await import('../lib/system-health');

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

const NOW = '2026-10-30T12:00:00.000Z';

function report(overrides: Partial<SystemHealthReport> = {}): SystemHealthReport {
  return {
    generatedAt: NOW,
    environment: 'staging',
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
    alerts: alertsBlock(),
    notMeasured: ['EXTERNAL_UPTIME', 'BACKUPS', 'HOST_RESOURCES', 'CAMPAIGN_EVALUATION_WORKER'],
    ...overrides,
  };
}

function alertsBlock(overrides: Partial<NonNullable<SystemHealthReport['alerts']>> = {}): NonNullable<SystemHealthReport['alerts']> {
  return {
    status: 'HEALTHY',
    reason: 'OK',
    checkedAt: NOW,
    engine: { cron: '*/5 * * * *', missedTicks: 0, lastStartedAt: NOW, lastSucceededAt: NOW, lastFailedAt: null, lastErrorType: null },
    channels: { email: true, telegram: true },
    open: [
      {
        ref: 'OPS-ABCDEFGH23',
        source: 'SCHEDULER',
        subjectKey: 'request-expiry',
        condition: 'DATABASE_ERROR',
        severity: 'CRITICAL',
        state: 'OPEN',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        occurrenceCount: 3,
        resolvedAt: null,
        resolution: null,
        deliveries: [
          { kind: 'OPENED', sequence: 0, channel: 'EMAIL', status: 'SENT', attemptCount: 1, sentAt: NOW, errorCode: null, recipientId: null, recipientLabel: null },
          { kind: 'OPENED', sequence: 0, channel: 'TELEGRAM', status: 'FAILED', attemptCount: 2, sentAt: null, errorCode: 'TIMEOUT', recipientId: null, recipientLabel: null },
        ],
      },
    ],
    recentlyResolved: [
      {
        ref: 'OPS-ZXCVBNM234',
        source: 'EMAIL',
        subjectKey: 'TRANSPORT_UNAVAILABLE',
        condition: 'SEND_FAILURES',
        severity: 'CRITICAL',
        state: 'RESOLVED',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        occurrenceCount: 5,
        resolvedAt: NOW,
        resolution: 'RECOVERED',
        deliveries: [{ kind: 'RESOLVED', sequence: 0, channel: 'EMAIL', status: 'SENT', attemptCount: 1, sentAt: NOW, errorCode: null, recipientId: null, recipientLabel: null }],
      },
    ],
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

describe('job wording (ADMIN-SYSTEM-HEALTH-002)', () => {
  it('keeps failed, late and switched-off apart', () => {
    expect(jobState({ enabled: true, reason: 'LAST_RUN_FAILED' })).toBe('FAILED');
    expect(jobState({ enabled: true, reason: 'LAST_RUN_INTERRUPTED' })).toBe('FAILED');
    expect(jobState({ enabled: true, reason: 'REPEATED_FAILURES' })).toBe('FAILED');
    expect(jobState({ enabled: true, reason: 'OVERDUE' })).toBe('LATE');
    expect(jobState({ enabled: false, reason: 'DISABLED' })).toBe('OFF');
    expect(jobState({ enabled: true, reason: 'LAST_RUN_SUCCEEDED' })).toBe('OK');
    expect(jobState({ enabled: true, reason: 'RUNNING' })).toBe('RUNNING');
    expect(jobState({ enabled: true, reason: 'NO_RECORDED_RUN' })).toBe('NO_DATA');
  });

  it('sums the scheduler section by what is wrong, not by an outage word', () => {
    const job = (reason: SystemHealthReport['schedulers']['jobs'][number]['reason'], enabled = true) =>
      ({ ...report().schedulers.jobs[0]!, enabled, reason });
    expect(
      schedulerSummaryLabel({ status: 'DOWN', reason: 'OK', jobs: [job('OVERDUE'), job('OVERDUE'), job('LAST_RUN_FAILED')] }),
    ).toBe('1 başarısız, 2 gecikmiş');
    expect(schedulerSummaryLabel({ status: 'DOWN', reason: 'OK', jobs: [job('OVERDUE'), job('DISABLED', false)] })).toBe(
      '1 gecikmiş',
    );
    expect(schedulerSummaryLabel({ status: 'HEALTHY', reason: 'OK', jobs: [job('LAST_RUN_SUCCEEDED')] })).toBe('Sağlıklı');
    expect(schedulerSummaryLabel({ status: 'UNKNOWN', reason: 'QUERY_FAILED', jobs: [] })).toBe('Bilinmiyor');
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

  it('names the deployment, and says so when it is not declared', async () => {
    for (const [environment, label] of [
      ['local', 'Yerel'],
      ['staging', 'Staging'],
      ['production', 'Production'],
      [null, 'Belirtilmemiş'],
    ] as const) {
      apiMocks.apiFetch.mockResolvedValue(report({ environment }));
      const markup = await renderPage();
      expect(markup).toMatch(new RegExp(`data-testid="system-health-environment" data-environment="${environment ?? 'unset'}">${label}<`));
    }
  });

  it('labels each job by its own state and keeps the real colour and missed count', async () => {
    const base = report();
    const late = {
      ...base.schedulers.jobs[0]!,
      key: 'request-reminder' as const,
      status: 'DOWN' as const,
      reason: 'OVERDUE' as const,
      missedTicks: 3,
      lastRun: { status: 'SUCCESS' as const, startedAt: NOW, finishedAt: NOW, errorType: null },
    };
    const off = { ...base.schedulers.jobs[1]!, key: 'showcase-lead-sla' as const };
    apiMocks.apiFetch.mockResolvedValue(
      report({ schedulers: { ...base.schedulers, status: 'DOWN', jobs: [base.schedulers.jobs[0]!, late, off] } }),
    );
    const markup = await renderPage();
    expect(markup).toMatch(/system-health-job-request-expiry.*?data-status="DEGRADED" data-job-state="FAILED">Başarısız</);
    expect(markup).toMatch(/system-health-job-request-reminder.*?data-status="DOWN" data-job-state="LATE">Gecikmiş</);
    expect(markup).toMatch(/system-health-job-request-reminder.*?Kaçırılan çalışma: 3 veya daha fazla\./);
    expect(markup).toMatch(/system-health-job-showcase-lead-sla.*?data-job-state="OFF">Kapalı</);
    expect(markup).toMatch(/data-testid="system-health-schedulers-status" data-status="DOWN">1 başarısız, 1 gecikmiş</);
    expect(markup).not.toMatch(/system-health-job-[a-z-]+".*?>Çalışmıyor</);
  });

  it('explains late jobs on a local machine, and only there', async () => {
    const base = report();
    const late = { ...base.schedulers.jobs[0]!, status: 'DOWN' as const, reason: 'OVERDUE' as const, missedTicks: 3 };
    const lateReport = (environment: SystemHealthReport['environment']) =>
      report({ environment, schedulers: { ...base.schedulers, status: 'DOWN', jobs: [late] } });

    apiMocks.apiFetch.mockResolvedValue(lateReport('local'));
    expect(await renderPage()).toContain('data-testid="system-health-local-late-note"');

    // Staging and production: the delay is shown as it is, with no excuse beside it.
    for (const environment of ['staging', 'production', null] as const) {
      apiMocks.apiFetch.mockResolvedValue(lateReport(environment));
      const markup = await renderPage();
      expect(markup).not.toContain('system-health-local-late-note');
      expect(markup).toMatch(/data-job-state="LATE">Gecikmiş</);
    }

    // Local with nothing late: no note.
    apiMocks.apiFetch.mockResolvedValue(report({ environment: 'local' }));
    expect(await renderPage()).not.toContain('system-health-local-late-note');
  });

  it('draws the overall state the API decided, folded with the API row', async () => {
    for (const overall of ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const) {
      apiMocks.apiFetch.mockResolvedValue(report({ overall }));
      expect(await renderPage()).toContain(`data-testid="system-health-overall" data-status="${overall}"`);
    }
  });

  describe('operations alerts (OBS-ALERT-001)', () => {
    it('draws the engine, the channels, open and recently closed alerts with per-channel delivery', async () => {
      apiMocks.apiFetch.mockResolvedValue(report());
      const markup = await renderPage();
      expect(markup).toContain('data-testid="system-health-alerts-status" data-status="HEALTHY"');
      expect(markup).toContain('Son başarılı değerlendirme');
      expect(markup).toContain('data-channel="telegram" data-configured="true"');
      expect(markup).toContain('data-testid="system-health-alert-OPS-ABCDEFGH23"');
      expect(markup).toContain('Talep süresi dolumu');
      expect(markup).toContain('Telegram: Açılış — Yeniden denenecek (2. deneme)');
      expect(markup).toContain('E-posta: Açılış — Gönderildi');
      expect(markup).toContain('data-testid="system-health-resolved-alert-OPS-ZXCVBNM234"');
      expect(markup).toContain('E-posta · Taşıma servisi kullanılamıyor');
      expect(markup).toContain('Düzeldi');
    });

    it('shows a late engine as late, and says when no channel is configured', async () => {
      apiMocks.apiFetch.mockResolvedValue(
        report({
          alerts: alertsBlock({
            status: 'DOWN',
            reason: 'OVERDUE',
            engine: { cron: '*/5 * * * *', missedTicks: 3, lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, lastErrorType: null },
            channels: { email: false, telegram: false },
            open: [],
            recentlyResolved: [],
          }),
        }),
      );
      const markup = await renderPage();
      expect(markup).toContain('data-testid="system-health-alerts-status" data-status="DOWN"');
      expect(markup).toContain(OPS_ALERT_ENGINE_REASON_TEXT.OVERDUE);
      expect(markup).toContain('kaçırılan çalışma: 3 veya daha fazla');
      expect(markup).toContain('data-testid="system-health-alerts-no-channel"');
      expect(markup).toContain('data-testid="system-health-alerts-none"');
    });

    it('says e-mail alerts are withheld when the e-mail block is', async () => {
      const { email: _omitted, ...withoutEmail } = report();
      apiMocks.apiFetch.mockResolvedValue(withoutEmail);
      const markup = await renderPage();
      expect(markup).toContain('data-testid="system-health-alerts-email-hidden"');
    });

    it('has Turkish copy for every engine reason', () => {
      for (const reason of ['OK', 'NEVER_RAN', 'OVERDUE', 'LAST_EVALUATION_FAILED', 'QUERY_FAILED'] as const) {
        expect(OPS_ALERT_ENGINE_REASON_TEXT[reason]).toMatch(/\S/);
      }
    });
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

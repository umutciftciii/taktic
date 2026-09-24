import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../middleware';
import { isLocalEnvironment } from '../lib/local-environment';
import { isNextControlFlowError, rethrowNextControlFlow } from '../lib/next-control-flow';
import { isNavItemActive, navGroups } from '../lib/nav';

/**
 * ADMIN-DESIGN-000: the access rules that are not a screen.
 *
 * Each case pins one decision from the fix: which unauthenticated paths the
 * middleware lets through, when the local sign-in hint appears, which throws
 * a `catch` must hand back to Next, and that a sidebar row asks for exactly
 * the permission its page asks for.
 */

const ADMIN = 'http://admin.test';

function request(path: string, cookie?: string) {
  return new NextRequest(`${ADMIN}${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe('middleware', () => {
  it('lets the session probe through without a cookie, so it can answer 401 itself', () => {
    const response = middleware(request('/api/session'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('still sends every other unauthenticated /api path to the sign-in page', () => {
    for (const path of ['/api/uploads/category-image', '/api/session/extra', '/api/sessions']) {
      const response = middleware(request(path));
      expect(response.headers.get('location'), path).toBe(`${ADMIN}/login`);
    }
  });

  it('sends an unauthenticated screen to the sign-in page and lets a signed-in one through', () => {
    expect(middleware(request('/requests')).headers.get('location')).toBe(`${ADMIN}/login`);
    expect(
      middleware(request('/requests', 'taktic_session=abc')).headers.get('location'),
    ).toBeNull();
  });
});

describe('the local sign-in hint', () => {
  it('appears on APP_ENVIRONMENT=local only', () => {
    expect(isLocalEnvironment({ APP_ENVIRONMENT: 'local' })).toBe(true);
    expect(isLocalEnvironment({ APP_ENVIRONMENT: ' local ' })).toBe(true);
    for (const value of [undefined, '', 'staging', 'production', 'LOCAL', 'development']) {
      expect(isLocalEnvironment({ APP_ENVIRONMENT: value }), String(value)).toBe(
        false,
      );
    }
  });
});

describe('Next control flow in a catch', () => {
  const redirectError = Object.assign(new Error('NEXT_REDIRECT'), {
    digest: 'NEXT_REDIRECT;replace;/yetkisiz;307;',
  });
  const notFoundError = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), {
    digest: 'NEXT_HTTP_ERROR_FALLBACK;404',
  });

  it('recognises redirect and notFound signals and nothing else', () => {
    expect(isNextControlFlowError(redirectError)).toBe(true);
    expect(isNextControlFlowError(notFoundError)).toBe(true);
    expect(isNextControlFlowError(new Error('boom'))).toBe(false);
    expect(isNextControlFlowError({ digest: 'SOMETHING_ELSE' })).toBe(false);
    expect(isNextControlFlowError(null)).toBe(false);
  });

  it('re-throws the signal and lets an ordinary error fall through', () => {
    expect(() => rethrowNextControlFlow(redirectError)).toThrow(redirectError);
    expect(() => rethrowNextControlFlow(new Error('boom'))).not.toThrow();
  });
});

describe('sidebar row ↔ page gate', () => {
  /**
   * The sidebar hides a row the session cannot open, so the row must ask for
   * exactly what the page asks for. F2 was a row on FINANCE_READ in front of
   * a page whose data needs FINANCE_LEDGER_READ: visible, then /yetkisiz.
   */
  const rows = navGroups.flatMap((group) => group.items);

  it.each(rows.map((row) => [row.href, row] as const))('%s', (href, row) => {
    const file = resolve(__dirname, '../app', `.${href === '/' ? '' : href}`, 'page.tsx');
    const source = readFileSync(file, 'utf8');
    if (row.superAdminOnly) {
      expect(source).toContain('requireSuperAdmin()');
      return;
    }
    const gate = source.match(/requireAdmin\(([^)]*)\)/);
    expect(gate, `${href} calls requireAdmin`).not.toBeNull();
    const required = [...(gate?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(required).toEqual([row.permission]);
  });
});

describe('every signed-in screen ↔ its sidebar row ↔ its gate (ADMIN-DESIGN-001)', () => {
  /**
   * All 52 signed-in page.tsx files, kept by hand. The first test fails the
   * moment a page is added or removed without this table changing with it, so
   * a new screen cannot arrive without somebody deciding which row lights on
   * it and which gate it asks for.
   *
   * `row` is the sidebar row that lights on the screen (null: none does) and
   * `gate` is exactly what the page's own guard asks for. Where the two
   * permissions differ, `exception` says why — those are the only screens a
   * session may reach from a row whose permission is not the page's.
   */
  type Screen = { row: string | null; gate: string[] | 'superAdmin'; exception?: string };
  const SCREENS: Record<string, Screen> = {
    '/': { row: '/', gate: ['DASHBOARD_READ'] },
    '/requests': { row: '/requests', gate: ['REQUESTS_READ'] },
    '/requests/[id]': { row: '/requests', gate: ['REQUESTS_READ'] },
    '/requests/reports': { row: '/requests/reports', gate: ['REQUEST_REPORTS_READ'] },
    '/offers': { row: '/offers', gate: ['OFFERS_READ'] },
    '/offers/[id]': { row: '/offers', gate: ['OFFERS_READ'] },
    '/providers': { row: '/providers', gate: ['PROVIDERS_READ'] },
    '/providers/[id]': {
      row: '/providers',
      gate: ['PROVIDERS_READ_DETAIL'],
      exception: 'A provider’s detail (raw registration data) is a narrower read than the list.',
    },
    '/providers/[id]/credits': {
      row: '/providers',
      gate: ['FINANCE_LEDGER_READ'],
      exception: 'A provider’s ledger is finance data, reached from the provider it belongs to.',
    },
    '/customers': { row: '/customers', gate: ['CUSTOMERS_READ'] },
    '/customers/[id]': { row: '/customers', gate: ['CUSTOMERS_READ'] },
    '/support': { row: '/support', gate: ['SUPPORT_READ'] },
    '/support/[id]': { row: '/support', gate: ['SUPPORT_READ'] },
    '/finance': { row: '/finance', gate: ['FINANCE_READ'] },
    '/finance/credit-ledger': { row: '/finance/credit-ledger', gate: ['FINANCE_LEDGER_READ'] },
    '/finance/manual-adjustments': { row: '/finance/manual-adjustments', gate: ['FINANCE_LEDGER_READ'] },
    '/finance/providers': { row: '/finance/providers', gate: ['FINANCE_READ'] },
    '/package-purchases': { row: '/package-purchases', gate: ['PACKAGE_PURCHASES_READ'] },
    '/package-purchases/[id]': { row: '/package-purchases', gate: ['PACKAGE_PURCHASES_READ'] },
    '/package-refunds': { row: '/package-refunds', gate: ['PACKAGE_REFUND_READ'] },
    '/package-refunds/[id]': { row: '/package-refunds', gate: ['PACKAGE_REFUND_READ'] },
    '/refund-scan': { row: '/refund-scan', gate: ['OFFER_REFUND_SCAN_READ'] },
    '/showcase/reviews': { row: '/showcase/reviews', gate: ['SHOWCASE_REVIEW_READ'] },
    '/showcase/reviews/[versionId]': { row: '/showcase/reviews', gate: ['SHOWCASE_REVIEW_READ'] },
    '/showcase/placements': { row: '/showcase/placements', gate: ['SHOWCASE_PLACEMENTS_READ'] },
    '/showcase/placements/[placementId]': { row: '/showcase/placements', gate: ['SHOWCASE_PLACEMENTS_READ'] },
    '/showcase/leads': { row: '/showcase/leads', gate: ['SHOWCASE_LEADS_READ'] },
    '/showcase/cards': { row: '/showcase/cards', gate: ['SHOWCASE_CARDS_READ'] },
    '/showcase/price-terms': { row: '/showcase/price-terms', gate: ['SHOWCASE_TERMS_ACCEPTANCES_READ'] },
    '/showcase/packages': { row: '/showcase/packages', gate: ['SHOWCASE_PACKAGES_READ'] },
    '/provider-reviews/reports': { row: '/provider-reviews/reports', gate: ['PROVIDER_REVIEWS_READ'] },
    '/provider-reviews/[reviewId]': { row: null, gate: ['PROVIDER_REVIEWS_READ'] },
    '/categories': { row: '/categories', gate: ['CATALOG_READ'] },
    '/categories/new': {
      row: '/categories',
      gate: ['CATALOG_READ', 'CATEGORIES_WRITE'],
      exception: 'A creation form also needs the write it performs.',
    },
    '/categories/[slug]': { row: '/categories', gate: ['CATALOG_READ'] },
    '/credit-packages': { row: '/credit-packages', gate: ['CREDIT_PACKAGES_READ'] },
    '/credit-packages/new': {
      row: '/credit-packages',
      gate: ['CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE'],
      exception: 'A creation form also needs the write it performs.',
    },
    '/credit-packages/[id]': { row: '/credit-packages', gate: ['CREDIT_PACKAGES_READ'] },
    '/operations-settings': { row: '/operations-settings', gate: ['OPERATIONS_SETTINGS_READ'] },
    '/campaigns': { row: '/campaigns', gate: ['CAMPAIGNS_READ'] },
    '/campaigns/new': {
      row: '/campaigns',
      gate: ['CAMPAIGNS_WRITE', 'CAMPAIGNS_READ'],
      exception: 'A creation form also needs the write it performs.',
    },
    '/campaigns/[id]': { row: '/campaigns', gate: ['CAMPAIGNS_READ'] },
    '/promotion-eligibility': { row: '/promotion-eligibility', gate: ['PROMOTION_ELIGIBILITY_REVIEW'] },
    '/promotion-eligibility/[eventId]': { row: '/promotion-eligibility', gate: ['PROMOTION_ELIGIBILITY_REVIEW'] },
    '/notifications': { row: '/notifications', gate: ['NOTIFICATION_LOGS_READ'] },
    '/notifications/[id]': { row: '/notifications', gate: ['NOTIFICATION_LOGS_READ'] },
    '/users': { row: '/users', gate: ['ADMIN_USERS_READ'] },
    '/users/new': {
      row: '/users',
      gate: 'superAdmin',
      exception: 'Creating a staff account is a root capability (F10).',
    },
    '/users/[id]': { row: '/users', gate: ['ADMIN_USERS_READ'] },
    '/roles': { row: '/roles', gate: 'superAdmin' },
    '/roles/[id]': { row: '/roles', gate: 'superAdmin' },
    '/company-settings': { row: '/company-settings', gate: ['COMPANY_SETTINGS_READ'] },
  };

  /** Reached without a session, or the refusal itself: no shell row, no gate. */
  const OUTSIDE_THE_SHELL = ['/login', '/admin-invite', '/yetkisiz'];

  const appDir = resolve(__dirname, '../app');

  function pageRoutes(dir: string, prefix = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        found.push(...pageRoutes(resolve(dir, entry.name), `${prefix}/${entry.name}`));
      } else if (entry.name === 'page.tsx') {
        found.push(prefix === '' ? '/' : prefix);
      }
    }
    return found;
  }

  function samplePath(route: string): string {
    return route.replace(/\[[^\]]+\]/g, 'sample-id');
  }

  it('lists every signed-in page.tsx, and nothing else', () => {
    const onDisk = pageRoutes(appDir)
      .filter((route) => !OUTSIDE_THE_SHELL.includes(route))
      .sort();
    expect(onDisk).toEqual(Object.keys(SCREENS).sort());
    expect(onDisk).toHaveLength(52);
  });

  it.each(Object.entries(SCREENS))('%s asks for exactly its recorded gate', (route, screen) => {
    const source = readFileSync(resolve(appDir, `.${route === '/' ? '' : route}`, 'page.tsx'), 'utf8');
    if (screen.gate === 'superAdmin') {
      expect(source).toContain('requireSuperAdmin()');
      expect(source).not.toMatch(/requireAdmin\(/);
      return;
    }
    const gate = source.match(/requireAdmin\(([^)]*)\)/);
    expect(gate, `${route} calls requireAdmin`).not.toBeNull();
    const required = [...(gate?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(required).toEqual(screen.gate);
  });

  it.each(Object.entries(SCREENS))('%s lights the recorded row', (route, screen) => {
    const lit = navGroups
      .flatMap((group) => group.items)
      .filter((row) => isNavItemActive(row, samplePath(route)))
      .map((row) => row.href);
    expect(lit).toEqual(screen.row ? [screen.row] : []);
  });

  it.each(Object.entries(SCREENS))('%s: a different gate from its row is a recorded exception', (_route, screen) => {
    if (!screen.row) return;
    const row = navGroups.flatMap((group) => group.items).find((entry) => entry.href === screen.row);
    const rowGate = row?.superAdminOnly ? 'superAdmin' : [row?.permission];
    const same = JSON.stringify(rowGate) === JSON.stringify(screen.gate);
    expect(same || Boolean(screen.exception)).toBe(true);
    // And an exception is only written where it is needed.
    if (same) expect(screen.exception).toBeUndefined();
  });
});

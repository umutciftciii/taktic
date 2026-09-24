import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '../middleware';
import { isLocalEnvironment } from '../lib/local-environment';
import { isNextControlFlowError, rethrowNextControlFlow } from '../lib/next-control-flow';
import { navGroups } from '../lib/nav';

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

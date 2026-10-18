import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminPasswordResetUrl } from '../src/common/web-routes';

/**
 * ADMIN-AUTH-001: a staff account's reset link lands on the admin panel. The
 * same guarantees as the web link — the token is the only parameter and cannot
 * escape it — over the admin app's origin.
 */
const ADMIN_URL_VARIABLES = ['ADMIN_APP_URL', 'ADMIN_ORIGIN', 'NEXT_PUBLIC_ADMIN_URL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ADMIN_URL_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of ADMIN_URL_VARIABLES) delete process.env[name];
});

afterEach(() => {
  for (const name of ADMIN_URL_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('adminPasswordResetUrl', () => {
  it('points at the admin panel reset page with the token as the only query value', () => {
    process.env.ADMIN_APP_URL = 'https://panel.example.test/';
    const parsed = new URL(adminPasswordResetUrl('abc/def?x=1&y=2#z'));

    expect(parsed.origin).toBe('https://panel.example.test');
    expect(parsed.pathname).toBe('/sifre-sifirla');
    expect(parsed.searchParams.get('token')).toBe('abc/def?x=1&y=2#z');
    expect([...parsed.searchParams.keys()]).toEqual(['token']);
    expect(parsed.hash).toBe('');
  });

  it('follows the same origin fallbacks as every other admin link', () => {
    process.env.ADMIN_ORIGIN = 'http://127.0.0.1:3202';
    expect(adminPasswordResetUrl('t')).toBe('http://127.0.0.1:3202/sifre-sifirla?token=t');

    delete process.env.ADMIN_ORIGIN;
    expect(adminPasswordResetUrl('t')).toBe('http://localhost:3002/sifre-sifirla?token=t');
  });
});

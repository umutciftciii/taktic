import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuthFrame } from '../app/auth-frame';
import { SiteFooter } from '../app/site-footer';
import { SiteHeader } from '../app/site-header';
import type { AuthUser } from '../lib/api';

/**
 * MOBILE-UX-HARDENING-001 — the source order the phone layout relies on.
 *
 * The phone layouts are the document read top to bottom, so what these check
 * is the order and the structure the server renders. The geometry itself — what
 * is on the first screen, what overflows — is the end-to-end suite's job
 * (e2e/tests/mobile-public-shell.spec.ts).
 */

// The visitor's header holds the start-choice modal, which asks for the app
// router; a static render has none.
vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
  useRouter: () => ({ push: () => undefined }),
}));

const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');

function indexOf(html: string, needle: string): number {
  const at = html.indexOf(needle);
  expect(at, `"${needle}" is in the markup`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('AuthFrame', () => {
  const html = renderToStaticMarkup(
    <AuthFrame tab="login">
      <h1 className="auth-screen-title">Tekrar hoş geldin</h1>
    </AuthFrame>,
  );

  it('renders the form before the poster', () => {
    expect(indexOf(html, 'auth-form-side')).toBeLessThan(indexOf(html, 'auth-poster'));
    expect(indexOf(html, '<h1')).toBeLessThan(indexOf(html, '<h2'));
  });

  it('marks the poster as complementary, labelled, and the frame as the split one', () => {
    expect(html).toMatch(/<aside class="auth-poster" aria-label="TakTick hesabı">/);
    expect(html).toMatch(/<main class="auth-screen auth-screen-split">/);
  });

  it('places the poster left only from the desktop breakpoint up', () => {
    const desktop = css.slice(css.indexOf('@media (min-width: 900px) {\n  .auth-screen-split'));
    expect(desktop).toMatch(/\.auth-screen-split > \.auth-poster \{\s*grid-column: 1;/);
    expect(desktop).toMatch(/\.auth-screen-split > \.auth-form-side \{\s*grid-column: 2;/);
  });
});

describe('SiteHeader', () => {
  it('wraps a visitor’s links in the phone menu, with a sign-in link inside it', () => {
    const html = renderToStaticMarkup(<SiteHeader user={null} providerId={null} />);
    expect(html).toContain('data-testid="site-menu-toggle"');
    expect(html).toContain('aria-expanded="false"');
    const panel = html.slice(indexOf(html, 'lp-menu-panel'));
    expect(panel).toContain('href="/categories"');
    expect(panel).toContain('lp-menu-signin');
  });

  it('gives a staff account no toggle — it has no public links to fold', () => {
    const admin = { id: 'a', role: 'ADMIN', name: 'Yönetici', email: 'a@example.test', phone: null } as unknown as AuthUser;
    const html = renderToStaticMarkup(<SiteHeader user={admin} providerId={null} />);
    expect(html).not.toContain('site-menu-toggle');
    expect(html).toContain('Kullanıcı menüsü');
  });
});

describe('SiteFooter', () => {
  const html = renderToStaticMarkup(<SiteFooter />);

  it('renders each group once, with a heading and a collapsed toggle for it', () => {
    for (const title of ['Hizmetler', 'Hizmet Veren', 'Yardım', 'Yasal']) {
      expect(html).toContain(`<h2 class="lp-footer-col-title">${title}</h2>`);
    }
    expect(html.match(/class="lp-footer-col-toggle"/g)).toHaveLength(4);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(html.match(/>Tüm Kategoriler</g)).toHaveLength(1);
  });

  it('keeps the legal links in their own landmark, outside the folding groups', () => {
    const legal = html.slice(indexOf(html, '<nav class="lp-footer-legal" aria-label="Yasal">'));
    for (const name of ['Kullanım Şartları', 'Gizlilik', 'KVKK']) {
      expect(legal).toContain(`>${name}</a>`);
    }
  });
});

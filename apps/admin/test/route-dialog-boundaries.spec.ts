import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BUG-SEO-ADMIN-MODAL-NAV-001: a query-driven window (`RouteDialog`, opened by
 * a link to the same screen with `?oneri=…`) must not sit under a
 * `loading.tsx` from a folder above its page.
 *
 * Such a `loading.tsx` is one Suspense boundary that stays mounted while the
 * screen changes only its query. A soft navigation is a transition, and React
 * keeps an already visible boundary's content rather than fall back to it;
 * when the new page then suspended on the window's client component, that
 * wait was intermittently never retried — the 200 came back and nothing
 * committed: no URL change, no window. A `loading.tsx` in the page's own
 * folder is keyed by the page's query and is new on every navigation, so it
 * is allowed.
 */

const appDir = resolve(__dirname, '../app');

function pageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...pageFiles(path));
    else if (entry.name === 'page.tsx') found.push(path);
  }
  return found;
}

function loadingAbove(page: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(dirname(page)); dir.startsWith(appDir); dir = dirname(dir)) {
    const loading = resolve(dir, 'loading.tsx');
    if (existsSync(loading)) found.push(relative(appDir, loading));
    if (dir === appDir) break;
  }
  return found;
}

const windowed = pageFiles(appDir).filter((file) => /<RouteDialog\b/.test(readFileSync(file, 'utf8')));

describe('query-driven windows ↔ loading boundaries', () => {
  it('finds the screens that open a RouteDialog', () => {
    expect(windowed.map((file) => relative(appDir, file)).sort()).toEqual(
      expect.arrayContaining(['seo/redirects/page.tsx', 'seo/slugs/page.tsx', 'showcase/packages/page.tsx']),
    );
  });

  it.each(windowed.map((file) => [relative(appDir, file), file] as const))(
    '%s has no loading.tsx above its own folder',
    (_name, file) => {
      expect(loadingAbove(file)).toEqual([]);
    },
  );

  it('keeps the SEO loading state on the two slow screens only', () => {
    expect(existsSync(resolve(appDir, 'seo/loading.tsx'))).toBe(false);
    expect(existsSync(resolve(appDir, 'seo/(overview)/loading.tsx'))).toBe(true);
    expect(existsSync(resolve(appDir, 'seo/indexing/loading.tsx'))).toBe(true);
  });
});

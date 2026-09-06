import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PANEL_ROUTE_PATTERNS,
  PUBLIC_ROUTE_OVERRIDES,
  isPanelRoute,
} from '../lib/panel-routes';

/**
 * The route lists in `lib/panel-routes.ts`, checked against the app directory.
 *
 * That file decides whether the root layout hands a route the public header and
 * footer. Getting it wrong is expensive in both directions and quiet in both:
 * a panel route left off the list gets a second, invisible account menu and a
 * second logout — the defect the list exists to fix — while a public route that
 * matches a pattern by accident loses the only navigation it has.
 *
 * So the list is not trusted here. Every `page.tsx` under `app/` is walked, its
 * route worked out from its path, and whether it renders a panel shell decided
 * by following its imports until `panel-drawer` is reached or the graph runs
 * out. `panel-drawer` rather than a list of shell names on purpose: it is the
 * component every panel frame is built on, so a new wrapper around one is found
 * without this test having to be told about it.
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** The module every panel frame ends up importing, whatever it calls itself. */
const PANEL_MARKER = 'panel-drawer';

/** Stands in for a dynamic segment. Deliberately unlike any static sibling. */
const SAMPLE_SEGMENT = 'e2e-sample-id';

type Page = {
  /** The route as this app's list writes it, e.g. `/providers/:id/offers`. */
  pattern: string;
  /** A concrete path that route would serve. */
  path: string;
  file: string;
  rendersPanelShell: boolean;
};

function listPages(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const full = resolve(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listPages(full));
    } else if (entry === 'page.tsx') {
      found.push(full);
    }
  }

  return found.sort();
}

/** `app/providers/[id]/offers/page.tsx` → `/providers/:id/offers`. */
function routePattern(file: string): string {
  const segments = relative(appDir, dirname(file))
    .split('/')
    .filter((segment) => segment.length > 0)
    // Route groups exist to organise files without appearing in the URL.
    .filter((segment) => !segment.startsWith('('))
    .map((segment) =>
      segment.startsWith('[') && segment.endsWith(']')
        ? `:${segment.slice(1, -1).replace(/^\.\.\./, '')}`
        : segment,
    );

  return `/${segments.join('/')}`;
}

function concretePath(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? SAMPLE_SEGMENT : segment))
    .join('/');
}

/** Relative imports only — a package cannot lead back into this app. */
function relativeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1] as string);
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);

  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }

  return null;
}

/** Does anything this page pulls in, however indirectly, build a panel frame? */
function rendersPanelShell(entry: string): boolean {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    if (file.includes(PANEL_MARKER)) return true;

    for (const specifier of relativeImports(file)) {
      const resolved = resolveModule(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return false;
}

const pages: Page[] = listPages(appDir).map((file) => {
  const pattern = routePattern(file);
  return {
    pattern,
    path: concretePath(pattern),
    file: relative(appDir, file),
    rendersPanelShell: rendersPanelShell(file),
  };
});

describe('panel routes', () => {
  it('finds the app directory', () => {
    // A silent zero would make every assertion below pass on nothing.
    expect(pages.length).toBeGreaterThan(20);
    expect(pages.some((page) => page.rendersPanelShell)).toBe(true);
    expect(pages.some((page) => !page.rendersPanelShell)).toBe(true);
  });

  it('agrees with every page in the app directory', () => {
    const disagreements = pages
      .filter((page) => isPanelRoute(page.path) !== page.rendersPanelShell)
      .map(
        (page) =>
          `${page.file} (${page.pattern}): the page ${page.rendersPanelShell ? 'renders' : 'does not render'} a panel shell, ` +
          `but isPanelRoute("${page.path}") says ${isPanelRoute(page.path)}`,
      );

    expect(
      disagreements,
      'lib/panel-routes.ts is out of step with app/ — add the route to PANEL_ROUTES, or to PUBLIC_ROUTES if it is a public screen a pattern swallowed',
    ).toEqual([]);
  });

  it('lists no route that no longer exists', () => {
    const existing = new Set(pages.map((page) => page.pattern));

    for (const pattern of PANEL_ROUTE_PATTERNS) {
      expect(existing, `PANEL_ROUTES lists ${pattern}, which has no page`).toContain(pattern);
    }

    for (const pattern of PUBLIC_ROUTE_OVERRIDES) {
      expect(existing, `PUBLIC_ROUTES lists ${pattern}, which has no page`).toContain(pattern);
    }
  });

  it('leaves an unknown path with its public chrome', () => {
    // A 404 is not a panel screen: whoever lands there keeps the header, which
    // on those pages is the only way out.
    expect(isPanelRoute('/')).toBe(false);
    expect(isPanelRoute('/bir-yerde-yok')).toBe(false);
    expect(isPanelRoute('/providers')).toBe(false);
    expect(isPanelRoute('/requests')).toBe(false);
    expect(isPanelRoute('/providers/abc/def/ghi/jkl')).toBe(false);
  });

  it('reads a trailing slash and a bare path the same way', () => {
    expect(isPanelRoute('/requests/my/')).toBe(true);
    expect(isPanelRoute('/requests/my')).toBe(true);
    expect(isPanelRoute('/providers/register/')).toBe(false);
  });

  it('keeps the public screens that share a prefix with a panel one', () => {
    // Each of these would be swallowed by /providers/:id or /requests/:id.
    expect(isPanelRoute('/providers/register')).toBe(false);
    expect(isPanelRoute('/providers/success')).toBe(false);
    expect(isPanelRoute('/requests/success')).toBe(false);
    // And the panel screens beside them are unaffected.
    expect(isPanelRoute('/providers/me')).toBe(true);
    expect(isPanelRoute('/requests/my')).toBe(true);
  });
});

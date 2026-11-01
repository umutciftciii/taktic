import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No client component reaches `lib/api.ts`.
 *
 * `lib/api.ts` imports `next/headers`, which only a Server Component may.
 * Vitest does not care, `tsc` does not care, `next dev` only complains on the
 * page that pulls it in — and `next build` refuses the whole admin. That is
 * how OBS-ALERT-002's routing panel (a client file) first failed: it took a
 * label table from `lib/system-health.ts`, whose own value import of
 * `lib/api.ts` came along with it.
 *
 * Walked from every `'use client'` file through its relative value imports
 * (`import type` and `export type` carry no code and are skipped). A
 * `'use server'` module is where the walk stops: a client may import a server
 * action, and that module runs on the server.
 */

const ROOT = resolve(__dirname, '..');
const API = resolve(ROOT, 'lib/api.ts');
const SOURCE = /\.(ts|tsx)$/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'test') continue;
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE.test(entry)) found.push(path);
  }
  return found;
}

function directive(source: string): 'client' | 'server' | null {
  const head = source.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*/g, '').trimStart();
  if (/^['"]use client['"]/.test(head)) return 'client';
  if (/^['"]use server['"]/.test(head)) return 'server';
  return null;
}

/** The relative modules a file imports or re-exports for their values. */
function valueImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const specifiers: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) {
    if (match[2]) continue;
    specifiers.push(match[4]!);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) specifiers.push(match[1]!);
  return specifiers
    .map((specifier) => {
      const base = resolve(dirname(path), specifier);
      return [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
    })
    .filter((resolved): resolved is string => Boolean(resolved));
}

/** The import chain from `start` to lib/api.ts, or null. */
function chainToApi(start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (path: string, trail: string[]): string[] | null => {
    if (path === API) return [...trail, path];
    if (seen.has(path)) return null;
    seen.add(path);
    if (trail.length > 0 && directive(readFileSync(path, 'utf8')) === 'server') return null;
    for (const next of valueImports(path)) {
      const found = walk(next, [...trail, path]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, []);
}

describe('client boundary', () => {
  const clients = [...sourceFiles(resolve(ROOT, 'app')), ...sourceFiles(resolve(ROOT, 'components')), ...sourceFiles(resolve(ROOT, 'lib'))].filter(
    (path) => directive(readFileSync(path, 'utf8')) === 'client',
  );

  it('finds the client components it guards', () => {
    expect(clients.map((path) => relative(ROOT, path))).toContain('app/system-health/notification-settings/routing-panel.tsx');
    expect(clients.length).toBeGreaterThan(20);
  });

  it('no client component imports lib/api.ts, directly or through another module', () => {
    const offenders = clients
      .map((path) => chainToApi(path))
      .filter((chain): chain is string[] => chain !== null)
      .map((chain) => chain.map((path) => relative(ROOT, path)).join(' → '));
    expect(offenders).toEqual([]);
  });
});

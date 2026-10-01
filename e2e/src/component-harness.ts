import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { repoRoot } from './runtime';

/**
 * Serves apps/admin/test/browser-harness/app.tsx — the admin's shared form
 * components under real React 19 — from a fake origin, for the components no
 * screen uses yet.
 *
 * The bundler is the esbuild `tsx` itself runs on (this package already runs
 * its scripts through tsx), reached through tsx's own dependency so that no
 * new package enters the lockfile. React is resolved from the admin app, so
 * the harness runs the exact React the panel ships.
 */
export const HARNESS_ORIGIN = 'http://component-harness.test';

type Esbuild = {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
};

let page: string | null = null;

async function harnessPage(): Promise<string> {
  if (page) return page;
  const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild') as Esbuild;
  const admin = resolve(repoRoot, 'apps/admin');
  const result = await esbuild.build({
    entryPoints: [resolve(admin, 'test/browser-harness/app.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    nodePaths: [resolve(admin, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"development"' },
    // ConfirmDialog asks a server action for its confirmation proof; there is
    // no server here, so the action module is swapped for the harness stub.
    plugins: [
      {
        name: 'confirmation-proof-stub',
        setup(build: { onResolve(options: { filter: RegExp }, callback: () => { path: string }): void }) {
          build.onResolve({ filter: /confirmation-proof-actions$/ }, () => ({
            path: resolve(admin, 'test/browser-harness/confirmation-proof-stub.ts'),
          }));
        },
      },
    ],
    logLevel: 'silent',
  });
  const css = readFileSync(resolve(admin, 'app/globals.css'), 'utf8');
  // `</script>` cannot occur in the bundle unescaped; guard it anyway.
  const [output] = result.outputFiles;
  if (!output) throw new Error('the component harness bundle came out empty');
  const js = output.text.replace(/<\/script/gi, '<\\/script');
  page = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  return page;
}

/** Routes every document request under the harness origin to the harness app. */
export async function openHarness(target: Page, path: string): Promise<void> {
  const html = await harnessPage();
  await target.route(`${HARNESS_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  );
  await target.goto(`${HARNESS_ORIGIN}${path}`);
}

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI-FONTS-001 — the panel's build reaches no font service.
 *
 * The panel loads no font at all: its type is the platform's own sans, written
 * out in globals.css (see the comment there). This pins that nothing brings a
 * fetched font back — no `next/font/google` import and no font service's
 * address in code or a stylesheet — and that the stack stays the platform's.
 */

const adminRoot = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '.next' ? [] : sourceFiles(path);
    return ['.ts', '.tsx', '.js', '.mjs', '.css'].includes(extname(name)) ? [path] : [];
  });
}

/** An import of the Google loader (comments may name it), the old package, or a font service's address. */
const FONT_SERVICES = [
  /from\s+['"](?:next|@next)\/font\/google['"]/,
  /require\(\s*['"](?:next|@next)\/font\/google['"]\s*\)/,
  /"@next\/font"\s*:/,
  /(?:https?:)?\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net)/,
];

describe('the admin panel’s fonts', () => {
  it('come from no font service', () => {
    const files = [
      ...sourceFiles(join(adminRoot, 'app')),
      ...sourceFiles(join(adminRoot, 'components')),
      ...sourceFiles(join(adminRoot, 'lib')),
      join(adminRoot, 'middleware.ts'),
      join(adminRoot, 'next.config.ts'),
      join(adminRoot, 'package.json'),
    ];
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return FONT_SERVICES.some((pattern) => pattern.test(text));
    });
    expect(offenders).toEqual([]);
  });

  it('are the platform’s own sans', () => {
    const css = readFileSync(join(adminRoot, 'app/globals.css'), 'utf8');
    expect(css).toContain(
      '--font-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
    );
    expect(css).not.toMatch(/@font-face/);
  });
});

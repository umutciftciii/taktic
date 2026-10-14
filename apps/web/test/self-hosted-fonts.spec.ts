import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * CI-FONTS-001 — the site's typeface is served from this repository, and the
 * build reaches no font service.
 *
 * `next/font/local` is a build-time transform; outside Next the call does
 * nothing useful, so it is replaced here by one that hands back the options it
 * was given. What app/fonts.ts declares is then checked against the files it
 * points at.
 */

type FontSource = { path: string; weight: string; style: string };
type FontOptions = {
  src: FontSource[];
  declarations: { prop: string; value: string }[];
  display: string;
  variable?: string;
  fallback?: string[];
  preload?: boolean;
  adjustFontFallback?: string | false;
};

vi.mock('next/font/local', () => ({
  default: (options: FontOptions) => ({ options, variable: '__variable', className: '__className' }),
}));

const { archivo, archivoLatinExt, archivoVietnamese } = (await import('../app/fonts')) as unknown as Record<
  'archivo' | 'archivoLatinExt' | 'archivoVietnamese',
  { options: FontOptions }
>;

const webRoot = resolve(__dirname, '..');
const appDir = join(webRoot, 'app');
const faces = [archivo, archivoLatinExt, archivoVietnamese].map(({ options }) => options);

// next's own copy of fontkit, the library next/font reads font files with.
const fontkit = (() => {
  const mod = createRequire(join(webRoot, 'package.json'))('next/dist/compiled/@next/font/dist/fontkit');
  return (mod.default?.default ?? mod.default ?? mod) as (buffer: Buffer) => {
    hasGlyphForCodePoint(codePoint: number): boolean;
    familyName: string;
    variationAxes: Partial<Record<string, { min: number; max: number }>>;
  };
})();

function declaration(options: FontOptions, prop: string) {
  return options.declarations.find((entry) => entry.prop === prop)?.value;
}

/** `U+0000-00FF, U+0131` → whether a code point falls in it. */
function inUnicodeRange(range: string, codePoint: number) {
  return range.split(',').some((part) => {
    const [from = '', to = from] = part.trim().replace(/^U\+/i, '').split('-');
    return codePoint >= parseInt(from, 16) && codePoint <= parseInt(to, 16);
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '.next' ? [] : sourceFiles(path);
    return ['.ts', '.tsx', '.js', '.mjs', '.css'].includes(extname(name)) ? [path] : [];
  });
}

/**
 * A font fetched over the network: an import of the Google loader (comments
 * may name it; code may not), the old `@next/font` package, or a font
 * service's address in a stylesheet or a link.
 */
const FONT_SERVICES = [
  /from\s+['"](?:next|@next)\/font\/google['"]/,
  /require\(\s*['"](?:next|@next)\/font\/google['"]\s*\)/,
  /"@next\/font"\s*:/,
  /(?:https?:)?\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net)/,
];

describe('the web app’s fonts', () => {
  it('come from no font service', () => {
    const files = [
      ...sourceFiles(appDir),
      ...sourceFiles(join(webRoot, 'lib')),
      join(webRoot, 'middleware.ts'),
      join(webRoot, 'next.config.ts'),
      join(webRoot, 'package.json'),
    ];
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return FONT_SERVICES.some((pattern) => pattern.test(text));
    });
    expect(offenders).toEqual([]);
  });

  it('are licensed WOFF2 files in this repository', () => {
    for (const face of faces) {
      for (const { path } of face.src) {
        const file = resolve(appDir, path);
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
        expect(readFileSync(join(dirname(file), 'OFL.txt'), 'utf8')).toContain(
          'licensed under the SIL Open Font License, Version 1.1',
        );
      }
    }
  });

  it('are one family, Archivo, at 400, 600 and 800, swapped in when loaded', () => {
    for (const face of faces) {
      expect(declaration(face, 'font-family')).toBe('Archivo');
      expect(declaration(face, 'font-stretch')).toBe('100%');
      expect(face.display).toBe('swap');
      expect(face.src.map(({ weight, style }) => `${weight} ${style}`)).toEqual(['400 normal', '600 normal', '800 normal']);
      for (const { path } of face.src) {
        const font = fontkit(readFileSync(resolve(appDir, path)));
        expect(font.familyName).toMatch(/^Archivo\b/);
        // One variable file drawn at every declared weight.
        expect(font.variationAxes.wght?.min).toBeLessThanOrEqual(400);
        expect(font.variationAxes.wght?.max).toBeGreaterThanOrEqual(800);
      }
    }
  });

  it('draw every Turkish letter from a preloaded file', () => {
    // A letter may sit in more than one face's range (ı is in latin's and
    // latin-ext's); the browser skips a face whose file lacks the glyph, so one
    // covering face with the glyph is enough — and it must be a preloaded one.
    for (const letter of 'çÇğĞıIiİöÖşŞüÜâÂîÎûÛ') {
      const codePoint = letter.codePointAt(0)!;
      const drawnBy = faces.filter(
        (face) =>
          inUnicodeRange(declaration(face, 'unicode-range') ?? '', codePoint) &&
          face.src.every(({ path }) => fontkit(readFileSync(resolve(appDir, path))).hasGlyphForCodePoint(codePoint)),
      );
      expect(drawnBy.length, letter).toBeGreaterThan(0);
      expect(drawnBy.every((face) => face.preload !== false), letter).toBe(true);
    }
  });

  it('preload latin and latin-ext, not vietnamese', () => {
    expect(faces.map((face) => face.preload !== false)).toEqual([true, true, false]);
  });

  it('publish --font-archivo, which the stylesheet and the root layout use', () => {
    expect(archivo.options.variable).toBe('--font-archivo');
    expect(faces.filter((face) => face.variable)).toHaveLength(1);
    const layout = readFileSync(join(appDir, 'layout.tsx'), 'utf8');
    expect(layout).toContain("import { archivo } from './fonts';");
    expect(layout).toContain('className={archivo.variable}');
    // Imported before the stylesheet, where the next/font/google call was.
    expect(layout.indexOf("from './fonts'")).toBeLessThan(layout.indexOf("import './globals.css'"));
    const css = readFileSync(join(appDir, 'globals.css'), 'utf8');
    expect(css).toContain('--font-heading: var(--font-archivo), system-ui, sans-serif;');
    expect(css).toContain('--font-body: var(--font-archivo), system-ui, sans-serif;');
  });

  it('fall back to Arial adjusted with the metrics the site has always used', () => {
    for (const face of faces) expect(face.adjustFontFallback).toBe(false);
    expect(archivo.options.fallback).toEqual(['"Archivo Fallback"']);
    const css = readFileSync(join(appDir, 'globals.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain(
      '@font-face { font-family: "Archivo Fallback"; src: local("Arial"); ascent-override: 88.96%; descent-override: 21.28%; line-gap-override: 0%; size-adjust: 98.7%; }',
    );
  });
});

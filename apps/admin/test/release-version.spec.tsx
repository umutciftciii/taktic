import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import config, { readReleaseVersion } from '../next.config';
import { AdminFooter as Footer } from '../components/release-version';

/**
 * RELEASE-BASELINE-001 — the footer's version is the root package.json's,
 * read by next.config.ts while code is compiled and inlined through `env`.
 * Nothing in this app writes the number itself.
 */

const rootVersion = (JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version: string }).version;

function rootWith(version: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'taktic-release-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'taktic', version }));
  return dir;
}

describe('the release version', () => {
  it('is read from the root package.json', () => {
    expect(readReleaseVersion()).toBe(rootVersion);
    expect(readReleaseVersion(rootWith('9.8.7'))).toBe('9.8.7');
  });

  it('refuses anything that is not MAJOR.MINOR.PATCH', () => {
    for (const bad of [undefined, '', 'v1.2.3', '1.2', '1.2.3-rc.1', 1]) {
      expect(() => readReleaseVersion(rootWith(bad)), String(bad)).toThrow(/MAJOR\.MINOR\.PATCH/);
    }
  });

  it('is inlined when code is compiled, and not read by next start', async () => {
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER]) {
      expect(config(phase).env, phase).toEqual({ TAKTIC_RELEASE_VERSION: rootVersion });
    }
    const runtime = config(PHASE_PRODUCTION_SERVER);
    expect(runtime.env).toBeUndefined();
    // The rest of the config is the same object in every phase.
    expect(await runtime.headers!()).toEqual(await config(PHASE_PRODUCTION_BUILD).headers!());
    expect(runtime.poweredByHeader).toBe(false);
  });

  it('is drawn as "Taktick vX.Y.Z", and not at all without a value', () => {
    expect(renderToStaticMarkup(<Footer version="9.8.7" />)).toBe('<footer class="admin-footer"><small data-testid="app-version">Taktick v9.8.7</small></footer>');
    expect(renderToStaticMarkup(<Footer version="" />)).toBe('');
  });
});

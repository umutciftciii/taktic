import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TIMEZONE-001: an admin date filter never builds its day boundaries from the
 * zone the admin server happens to run in.
 *
 * The offer and request lists used to do exactly that — `new Date(day)` (UTC
 * midnight) for the start and `setHours(23, 59, 59, 999)` (host-local) for the
 * end — so the same filter answered differently in a UTC container and on an
 * Istanbul laptop. The boundaries are now drawn by `@taktic/shared`
 * (`orderIsoDayRange`, `isoDayRangeBounds`) or by the API from the
 * `YYYY-MM-DD` the screen sends. This pins that no screen goes back to the
 * host clock for it; the arithmetic itself is tested in the shared package.
 */

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('admin date filters', () => {
  it('no screen sets a day boundary on the host clock', () => {
    const offenders = [...sources('app'), ...sources('lib'), ...sources('components')].filter((path) =>
      /\.setHours\(/.test(read(path)),
    );
    expect(offenders.map((path) => relative(ROOT, join(ROOT, path)))).toEqual([]);
  });

  it('the offer list sends the days themselves, in order', () => {
    const page = read('app/offers/page.tsx');
    expect(page).toContain("orderIsoDayRange(params.from, params.to)");
    expect(page).toContain("apiQuery.set('submittedFrom', fromValue)");
    expect(page).toContain("apiQuery.set('submittedTo', toValue)");
    expect(page).not.toMatch(/new Date\((fromValue|toValue)\)/);
  });

  it('the request list filters on the half-open Istanbul window', () => {
    const page = read('app/requests/page.tsx');
    expect(page).toContain('isoDayRangeBounds(dayRange.from, dayRange.to)');
    expect(page).toContain('submitted >= untilDate');
  });

  it('the people lists send ordered days', () => {
    expect(read('app/users/page.tsx')).toContain('orderIsoDayRange(params.createdFrom, params.createdTo)');
    expect(read('app/users/page.tsx')).toContain('orderIsoDayRange(params.lastLoginFrom, params.lastLoginTo)');
    expect(read('app/customers/page.tsx')).toContain('orderIsoDayRange(params.lastRequestFrom, params.lastRequestTo)');
  });
});

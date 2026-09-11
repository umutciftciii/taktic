import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The card-bound sale is gone from the API. This walks every source file the
 * web and admin applications ship and refuses a reference to any of its
 * routes, so a screen cannot quietly keep calling a path that now answers 404.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  resolve(here, '..', 'app'),
  resolve(here, '..', 'lib'),
  resolve(here, '..', '..', 'admin', 'app'),
  resolve(here, '..', '..', 'admin', 'lib'),
];

/**
 * `/showcase/cards/${id}/price-terms` and `…/price-terms-acceptances` — the
 * per-card terms the sale used to read and write. Card-scoped on purpose: the
 * admin's `/admin/showcase/price-terms-acceptances` ledger is still served.
 */
const FORBIDDEN_CARD_TERMS = /\/showcase\/cards\/\$\{[^}]+\}\/price-terms(-acceptances)?\b/;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the removed card-bound vitrin routes', () => {
  it('are referenced by no screen or action', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((root) => walk(root))) {
      const source = readFileSync(file, 'utf8');
      if (
        source.includes('/placements/checkout') ||
        source.includes('/placements/eligibility') ||
        FORBIDDEN_CARD_TERMS.test(source)
      ) {
        offenders.push(relative(here, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

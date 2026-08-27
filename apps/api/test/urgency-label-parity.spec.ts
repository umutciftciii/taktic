import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { URGENCY_LABELS, urgencyLabel } from '../src/common/urgency';

/**
 * The seam between the two copies of the urgency table.
 *
 * `src/common/urgency.ts` is what the e-mail templates render from;
 * `packages/shared/src/urgency.ts` is what the web and admin screens render
 * from. They are copies because this package compiles with `rootDir: src` and
 * the shared package ships no build output, so the API cannot import it without
 * reshaping two build setups for one lookup table.
 *
 * Copies drift, and the drift is exactly the bug this table was added for: the
 * screens knew what `THIS_WEEK` meant and the e-mails did not. So the copy is
 * read off disk and compared here — cheap, and it fails the moment somebody
 * adds an option to one side only.
 *
 * Text rather than an import on purpose: importing across the package boundary
 * is what `tsc -p tsconfig.test.json` (rootDir ".") refuses, and reading the
 * file makes the check independent of both build setups.
 */

const SHARED_TABLE = resolve(__dirname, '../../../packages/shared/src/urgency.ts');

/** Pulls `CODE: 'Label',` pairs out of the exported object literal. */
function parseTable(source: string): Record<string, string> {
  const body = /export const URGENCY_LABELS = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (!body?.[1]) {
    throw new Error(`URGENCY_LABELS object literal not found in ${SHARED_TABLE}`);
  }

  const entries = [...body[1].matchAll(/([A-Z][A-Z_]*)\s*:\s*'([^']*)'/g)].map(
    ([, code, label]) => [code as string, label as string] as const,
  );

  if (entries.length === 0) {
    throw new Error('URGENCY_LABELS parsed as empty; the parity check would pass vacuously');
  }

  return Object.fromEntries(entries);
}

describe('urgency labels', () => {
  it('says the same thing in the e-mails as on the screens', () => {
    const shared = parseTable(readFileSync(SHARED_TABLE, 'utf8'));
    expect(shared).toEqual({ ...URGENCY_LABELS });
  });

  it('covers every option the request form offers', () => {
    // apps/web/app/categories/[slug]/request-form.tsx. A fourth option added
    // there without a label here would print its code at a customer.
    for (const code of ['TODAY', 'THIS_WEEK', 'FLEXIBLE']) {
      expect(urgencyLabel(code)).toBeTruthy();
    }
  });

  it('never returns anything that looks like a storage code', () => {
    for (const [code, label] of Object.entries(URGENCY_LABELS)) {
      expect(label).not.toMatch(/^[A-Z][A-Z_]*$/);
      expect(label).not.toContain(code);
      expect(label).not.toContain('_');
    }
  });

  it('answers null for absent, blank and unrecognised values', () => {
    expect(urgencyLabel(null)).toBeNull();
    expect(urgencyLabel(undefined)).toBeNull();
    expect(urgencyLabel('   ')).toBeNull();
    // The old behaviour was `?? urgency`, which is what put a code on a screen.
    expect(urgencyLabel('SOME_FUTURE_CODE')).toBeNull();
    expect(urgencyLabel('this_week')).toBeNull();
  });

  it('trims what the column actually holds', () => {
    expect(urgencyLabel(' THIS_WEEK ')).toBe(URGENCY_LABELS.THIS_WEEK);
  });
});

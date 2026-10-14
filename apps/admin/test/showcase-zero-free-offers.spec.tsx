import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREE_OFFER_COUNT_HELP, FREE_OFFER_COUNT_MAX, FREE_OFFER_COUNT_MIN } from '../app/showcase/packages/showcase-package-fields';
import { freeOfferCountText } from '../lib/showcase-free-offers';

/**
 * SHOWCASE-ALLOWANCE-003 — the operator may set a vitrin package to 0 free
 * offers, and 0 reads "Ücretsiz teklif hakkı yok" on the admin screens.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('zero free offers on the admin screens', () => {
  it('the form takes 0..50, and its help says what 0 means', () => {
    expect(FREE_OFFER_COUNT_MIN).toBe(0);
    expect(FREE_OFFER_COUNT_MAX).toBe(50);
    expect(FREE_OFFER_COUNT_HELP).toContain('0–50');
    expect(FREE_OFFER_COUNT_HELP).toContain('0 = ücretsiz teklif hakkı yok');
  });

  it('the wording helper names 0', () => {
    expect(freeOfferCountText(0)).toBe('Ücretsiz teklif hakkı yok');
    expect(freeOfferCountText(3)).toBe('3 teklif');
  });

  it('every screen that shows a package or right count branches on 0', () => {
    for (const path of [
      'app/showcase/packages/page.tsx',
      'app/showcase/packages/[id]/page.tsx',
      'app/showcase/reviews/[versionId]/page.tsx',
      'app/showcase/placements/[placementId]/placement-allowance-section.tsx',
    ]) {
      expect(read(path), path).toContain('NO_FREE_OFFERS_TEXT');
    }
  });
});

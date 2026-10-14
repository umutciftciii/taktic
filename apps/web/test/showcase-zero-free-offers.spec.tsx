import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfferCostPanel } from '../app/providers/[id]/vitrin/talepler/[leadId]/offer-cost-panel';
import { freeOfferCountText, NO_FREE_OFFERS_TEXT } from '../lib/showcase-free-offers';

/**
 * SHOWCASE-ALLOWANCE-003 — a package / run with 0 free offers reads
 * "Ücretsiz teklif hakkı yok" on every provider screen, never "0 ücretsiz
 * teklif hakkı", and its leads show the plain credit price.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('zero free offers on the provider screens', () => {
  it('the wording helper names 0 and counts the rest', () => {
    expect(freeOfferCountText(0)).toBe('Ücretsiz teklif hakkı yok');
    expect(freeOfferCountText(1)).toBe('1 ücretsiz teklif hakkı');
    expect(freeOfferCountText(5)).toBe('5 ücretsiz teklif hakkı');
  });

  it('every screen that shows a count branches on 0', () => {
    for (const path of [
      'app/providers/[id]/vitrin/paketler/package-picker.tsx',
      'app/providers/[id]/vitrin/yeni/page.tsx',
      'app/providers/[id]/vitrin/[cardId]/page.tsx',
      'app/providers/[id]/vitrin/odeme/[purchaseId]/page.tsx',
      'app/providers/[id]/vitrin/talepler/[leadId]/page.tsx',
    ]) {
      expect(read(path), path).toMatch(/NO_FREE_OFFERS_TEXT|freeOfferCountText/);
    }
    expect(read('app/providers/[id]/vitrin/talepler/[leadId]/page.tsx')).toContain('lead.freeOfferCount === 0');
    expect(read('app/providers/[id]/vitrin/[cardId]/page.tsx')).toContain('entry.liveFreeOfferCount === 0');
  });

  it('a zero run’s lead shows the credit price and no allowance line', () => {
    const html = renderToStaticMarkup(
      <OfferCostPanel preview={{ kind: 'CREDITS', creditCost: 2, categoryCreditCost: 2, allowance: null } as never} />,
    );
    expect(html).toContain('Bu teklif 2 kredi.');
    expect(html).not.toContain('lead-offer-allowance');
    expect(html).not.toContain('haklar');
    expect(NO_FREE_OFFERS_TEXT).toBe('Ücretsiz teklif hakkı yok');
  });
});

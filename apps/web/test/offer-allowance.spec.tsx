import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfferCostPanel } from '../app/providers/[id]/vitrin/talepler/[leadId]/offer-cost-panel';
import type { OfferCostPreview } from '../lib/api';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the direct-lead cost line: every state a
 * sentence (never colour alone), the allowance written out, and no screen left
 * promising that answering is free without bound.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

function preview(overrides: Partial<OfferCostPreview> = {}): OfferCostPreview {
  return {
    kind: 'SHOWCASE_ALLOWANCE',
    creditCost: 0,
    categoryCreditCost: 2,
    allowance: { quotaTotal: 3, quotaUsed: 1, remaining: 2 },
    ...overrides,
  };
}

describe('OfferCostPanel', () => {
  it('a free slot: 0 credits, the normal price beside it, and "2 / 3" left — in a status region', () => {
    const html = renderToStaticMarkup(<OfferCostPanel preview={preview()} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Bu teklif vitrin hakkınızdan düşecek — 0 kredi (normalde 2 kredi).');
    expect(html).toMatch(/<strong>2 \/ 3<\/strong>/);
    expect(html).toContain('data-cost-kind="SHOWCASE_ALLOWANCE"');
    expect(html).toContain('data-credit-cost="0"');
  });

  it('the slots spent: the category price, said as a sentence', () => {
    const html = renderToStaticMarkup(
      <OfferCostPanel
        preview={preview({ kind: 'CREDITS', creditCost: 2, allowance: { quotaTotal: 3, quotaUsed: 3, remaining: 0 } })}
      />,
    );
    expect(html).toContain('Bu yayın döneminin ücretsiz teklif hakları bitti; bu teklif 2 kredi.');
    expect(html).toMatch(/<strong>0 \/ 3<\/strong>/);
  });

  it('no credits, a package, a daily cap and an unreadable preview each say what they are', () => {
    expect(renderToStaticMarkup(<OfferCostPanel preview={preview({ kind: 'INSUFFICIENT_CREDITS', creditCost: 2 })} />)).toContain(
      'bakiyeniz yetersiz',
    );
    expect(renderToStaticMarkup(<OfferCostPanel preview={preview({ kind: 'UNLIMITED', creditCost: 2 })} />)).toContain(
      'limitsiz paketinizden karşılanır',
    );
    expect(renderToStaticMarkup(<OfferCostPanel preview={preview({ kind: 'MONTHLY_QUOTA', creditCost: 2 })} />)).toContain(
      'aylık paket kotanızdan 2 kredi',
    );
    expect(renderToStaticMarkup(<OfferCostPanel preview={preview({ kind: 'DAILY_LIMIT', creditCost: 2 })} />)).toContain(
      'bugünkü teklif sınırına',
    );
    expect(renderToStaticMarkup(<OfferCostPanel preview={null} />)).toContain('hesaplanamadı');
  });

  it('a marketplace-shaped preview (no allowance) shows no allowance line', () => {
    const html = renderToStaticMarkup(<OfferCostPanel preview={preview({ kind: 'CREDITS', creditCost: 2, allowance: null })} />);
    expect(html).not.toContain('lead-offer-allowance');
    expect(html).toContain('Bu teklif 2 kredi.');
  });
});

describe('the bounded copy', () => {
  it('no provider vitrin screen promises unbounded free answers any more', () => {
    for (const path of [
      'app/providers/[id]/vitrin/talepler/page.tsx',
      'app/providers/[id]/vitrin/talepler/[leadId]/page.tsx',
      'app/providers/[id]/vitrin/paketler/page.tsx',
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(/kredi harcanmaz|kredisi harcanmadı/);
    }
    // SHOWCASE-ALLOWANCE-001: the count is the package's, never a fixed 3.
    for (const path of [
      'app/providers/[id]/vitrin/talepler/page.tsx',
      'app/providers/[id]/vitrin/talepler/[leadId]/page.tsx',
      'app/providers/[id]/vitrin/paketler/page.tsx',
    ]) {
      expect(read(path), path).not.toMatch(/\b3 ücretsiz teklif/);
    }
    expect(read('app/providers/[id]/vitrin/talepler/page.tsx')).toContain('paketin içerdiği sayıda ücretsiz teklif hakkı');
    expect(read('app/providers/[id]/vitrin/talepler/[leadId]/page.tsx')).toContain(
      '${costPreview.allowance.quotaTotal} ücretsiz teklif hakkınız bulunur',
    );
    expect(read('app/providers/[id]/vitrin/paketler/page.tsx')).toContain('kaç hak kazanacağınız her paketin üzerinde yazar');
  });

  it('the lead action posts the previewed cost and maps the 402', () => {
    const action = read('app/providers/[id]/vitrin/talepler/[leadId]/actions.ts');
    expect(action).toContain("readOptionalNumber(formData, 'expectedCreditCost')");
    expect(action).toContain("return 'INSUFFICIENT_CREDIT'");
  });
});

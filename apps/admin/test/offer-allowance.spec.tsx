import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlacementAllowanceSection } from '../app/showcase/placements/[placementId]/placement-allowance-section';
import type { ShowcaseOfferAllowance } from '../lib/api';

/**
 * CAMPAIGN-ENTITLEMENT-001 — the operator's view of a run's free-offer
 * allowance and of the slot that paid for an offer.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

function allowance(overrides: Partial<ShowcaseOfferAllowance> = {}): ShowcaseOfferAllowance {
  return {
    id: 'oag_1',
    status: 'ACTIVE',
    quotaTotal: 5,
    quotaUsed: 4,
    remaining: 1,
    legacyFreeOffers: 2,
    subsidyCredits: 6,
    validFrom: '2026-10-01T09:00:00.000Z',
    grantedAt: '2026-10-01T09:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    usages: [
      {
        ordinal: 3,
        offerId: 'offer-3',
        offerNumber: 'TK-3',
        offerStatus: 'SUBMITTED',
        requestId: 'req-3',
        listCreditCostSnapshot: 3,
        consumedAt: '2026-10-02T09:00:00.000Z',
      },
      {
        ordinal: 4,
        offerId: 'offer-4',
        offerNumber: 'TK-4',
        offerStatus: 'WITHDRAWN',
        requestId: 'req-4',
        listCreditCostSnapshot: 3,
        consumedAt: '2026-10-03T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('placement allowance section', () => {
  it('states used / total, what is left, the subsidy and the legacy count, as text', () => {
    const html = renderToStaticMarkup(<PlacementAllowanceSection allowance={allowance()} canOpenOffer packageFreeOfferCount={3} />);
    expect(html).toContain('Ücretsiz teklif hakkı');
    expect(html).toMatch(/data-testid="placement-allowance-usage">4 \/ 5</);
    expect(html).toContain('6 kredi (normal kategori bedeli)');
    expect(html).toContain('2 ücretsiz teklif geçişte sayıldı');
    expect(html).toContain('href="/offers/offer-3"');
    expect(html).toContain('3 / 5');
    // A free slot is never presented as a credit movement.
    expect(html).toContain('kredi hareketi yazılmaz');
  });

  it('shows the package count the run was sold with (SHOWCASE-ALLOWANCE-001)', () => {
    const html = renderToStaticMarkup(<PlacementAllowanceSection allowance={allowance()} canOpenOffer packageFreeOfferCount={5} />);
    expect(html).toMatch(/data-testid="placement-allowance-package-count">5 teklif \(satın alma anındaki paket değeri\)</);
  });

  it('without OFFERS_READ the API sends no usages, and without the link permission no link', () => {
    const noUsages = renderToStaticMarkup(
      <PlacementAllowanceSection allowance={allowance({ usages: undefined })} canOpenOffer={false} packageFreeOfferCount={3} />,
    );
    expect(noUsages).not.toContain('placement-allowance-usages');
    const noLink = renderToStaticMarkup(<PlacementAllowanceSection allowance={allowance()} canOpenOffer={false} packageFreeOfferCount={3} />);
    expect(noLink).not.toContain('href="/offers/');
    expect(noLink).toContain('TK-3');
  });

  it('a run without a grant says so instead of inventing zeros', () => {
    const html = renderToStaticMarkup(<PlacementAllowanceSection allowance={null} canOpenOffer packageFreeOfferCount={3} />);
    expect(html).toContain('placement-allowance-none');
    expect(html).not.toContain('placement-allowance-usage"');
  });
});

describe('offer detail payment source', () => {
  it('names the vitrin slot, separately from the credit transactions', () => {
    const page = read('app/offers/[id]/page.tsx');
    expect(page).toContain("label: 'Ödeme kaynağı'");
    expect(page).toContain('Vitrin ücretsiz teklif hakkı ·');
    expect(page).toContain('Eski sınırsız vitrin hakkı');
  });
});

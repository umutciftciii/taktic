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
    openLeads: 1,
    voidedAt: null,
    voidReason: null,
    voidNote: null,
    voidedBy: null,
    voidedRemaining: 0,
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
    const html = renderToStaticMarkup(<PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={allowance()} canOpenOffer packageFreeOfferCount={3} />);
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
    const html = renderToStaticMarkup(<PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={allowance()} canOpenOffer packageFreeOfferCount={5} />);
    expect(html).toMatch(/data-testid="placement-allowance-package-count">5 teklif \(satın alma anındaki paket değeri\)</);
  });

  it('without OFFERS_READ the API sends no usages, and without the link permission no link', () => {
    const noUsages = renderToStaticMarkup(
      <PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={allowance({ usages: undefined })} canOpenOffer={false} packageFreeOfferCount={3} />,
    );
    expect(noUsages).not.toContain('placement-allowance-usages');
    const noLink = renderToStaticMarkup(<PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={allowance()} canOpenOffer={false} packageFreeOfferCount={3} />);
    expect(noLink).not.toContain('href="/offers/');
    expect(noLink).toContain('TK-3');
  });

  it('a run sold with 0 free offers (SHOWCASE-ALLOWANCE-003) says there is none, not that it predates allowances', () => {
    const html = renderToStaticMarkup(<PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={null} canOpenOffer packageFreeOfferCount={0} />);
    expect(html).toContain('Ücretsiz teklif hakkı yok');
    expect(html).not.toContain('sisteminden önce sona erdi');
  });

  it('a run without a grant says so instead of inventing zeros', () => {
    const html = renderToStaticMarkup(<PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={null} canOpenOffer packageFreeOfferCount={3} />);
    expect(html).toContain('placement-allowance-none');
    expect(html).not.toContain('placement-allowance-usage"');
  });
});

describe('SHOWCASE-ALLOWANCE-004 — the void, on the placement', () => {
  const voided = allowance({
    status: 'VOID',
    remaining: 1,
    voidedAt: '2026-10-04T09:00:00.000Z',
    voidReason: 'FRAUD',
    voidNote: 'İç inceleme notu, yalnız personel görür.',
    voidedBy: { id: 'sa_1', name: 'Kök Yönetici' },
    voidedRemaining: 1,
  });

  it('says VOID in words, with who, why, the internal note and how many slots it took', () => {
    const html = renderToStaticMarkup(
      <PlacementAllowanceSection placementId="pl_1" canVoid allowance={voided} canOpenOffer packageFreeOfferCount={3} />,
    );
    expect(html).toContain('data-testid="placement-allowance-voided"');
    expect(html).toMatch(/data-testid="placement-allowance-status">İptal edildi</);
    expect(html).toMatch(/data-testid="placement-allowance-remaining">0 \(1 hak iptal edildi\)</);
    expect(html).toContain('Kök Yönetici');
    expect(html).toContain('Sahte veya kurgu talep');
    expect(html).toContain('İç inceleme notu, yalnız personel görür.');
    // A VOID grant offers no second void.
    expect(html).not.toContain('placement-allowance-void-form');
  });

  it('the history lists the grant, each use and the void, newest first', () => {
    const html = renderToStaticMarkup(
      <PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={voided} canOpenOffer packageFreeOfferCount={3} />,
    );
    const order = ['placement-allowance-history-voided', 'placement-allowance-history-usage-4', 'placement-allowance-history-usage-3', 'placement-allowance-history-granted'].map(
      (id) => html.indexOf(id),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('Kalan 1 hak iptal edildi — Sahte veya kurgu talep');
  });

  it('the form is a super admin’s, only while something is left, and posts the figures it shows', () => {
    const active = allowance({ quotaTotal: 5, quotaUsed: 2, remaining: 3, openLeads: 4 });
    const html = renderToStaticMarkup(
      <PlacementAllowanceSection placementId="pl_1" canVoid allowance={active} canOpenOffer packageFreeOfferCount={5} />,
    );
    expect(html).toContain('data-testid="placement-allowance-void-form"');
    expect(html).toMatch(/name="expectedQuotaTotal" value="5"/);
    expect(html).toMatch(/name="expectedQuotaUsed" value="2"/);
    expect(html).toMatch(/name="expectedOpenLeads" value="4"/);
    expect(html).toContain('Kalan 3 ücretsiz teklif hakkı iptal edilir.');
    expect(html).toContain('Ücretsiz yanıt bekleyen 4 talep kapanmaz');
    expect(html).toContain('Para iadesi, kredi hareketi veya yerleşim iptali yapılmaz.');
    expect(html).toContain('gerekçe kodu ve iç açıklama e-postada yer almaz');
    for (const code of ['FRAUD', 'ABUSE', 'TERMS_VIOLATION', 'OPERATOR_ERROR', 'OTHER']) {
      expect(html).toContain(`value="${code}"`);
    }

    const notRoot = renderToStaticMarkup(
      <PlacementAllowanceSection placementId="pl_1" canVoid={false} allowance={active} canOpenOffer packageFreeOfferCount={5} />,
    );
    expect(notRoot).not.toContain('placement-allowance-void-form');
    const spent = renderToStaticMarkup(
      <PlacementAllowanceSection
        placementId="pl_1"
        canVoid
        allowance={allowance({ quotaTotal: 5, quotaUsed: 5, remaining: 0 })}
        canOpenOffer
        packageFreeOfferCount={5}
      />,
    );
    expect(spent).not.toContain('placement-allowance-void-form');
  });

  it('the action refuses without its proof, a reason code or a real note, before any request', () => {
    const action = read('app/showcase/placements/actions.ts');
    expect(action).toContain("hasConfirmationProof(formData, 'showcase.allowance-void')");
    expect(action).toContain('OFFER_ALLOWANCE_VOID_REASON_REQUIRED');
    expect(action).toContain('OFFER_ALLOWANCE_VOID_NOTE_REQUIRED');
    expect(action).toContain('/allowance/void');
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

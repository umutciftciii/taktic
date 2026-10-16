import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LIST_PRICE_DISCLAIMER,
  MethodologySection,
  UsageKpis,
  VALUE_DISCLAIMER,
  VALUE_SECTION_TITLE,
  ValueSection,
} from '../app/finance/offer-allowances/report-sections';
import type { OfferAllowanceReport } from '../lib/api';
import {
  NOT_AVAILABLE,
  describeIndicativeValue,
  describeWindow,
  formatBucket,
  formatMinorOrNa,
} from '../lib/offer-allowance-report';

/**
 * SHOWCASE-ALLOWANCE-002 — what the free vitrin offer report promises on the
 * page: an unvalued figure is N/A and never ₺0, the list price is a separate
 * reference, and the TL figure says it is not revenue.
 */

const EMPTY_COHORT = {
  grants: 0,
  defined: 0,
  usedTracked: 0,
  usedLegacy: 0,
  remainingUsable: 0,
  remainingUsableViaOpenLeads: 0,
  remainingUnusable: 0,
  remainingVoided: 0,
};

function reportWith(overrides: Partial<OfferAllowanceReport> = {}): OfferAllowanceReport {
  return {
    range: { from: null, to: null, groupBy: 'month', timezone: 'Europe/Istanbul' },
    filters: { packageId: null, providerId: null, categoryId: null },
    timeBases: { cohort: 'GRANT_VALID_FROM', usage: 'USAGE_CONSUMED_AT', unplaced: 'ENTITLEMENT_GRANTED_AT', valuation: 'x' },
    cohort: EMPTY_COHORT,
    usage: { usages: 2, credits: 4, valuedCredits: 0, unvaluedCredits: 4, indicativeValueMinor: null },
    unplaced: { pendingRights: 1, pendingFreeOffers: 3, expiredRights: 0, expiredFreeOffers: 0 },
    valuation: {
      method: 'MONTHLY_WEIGHTED_PAID_CREDIT_PACKAGES',
      months: [{ month: '2026-10', usages: 2, credits: 4, purchases: 0, paidAmountMinor: null, soldCredits: null, perCreditMinor: null }],
      listPriceReference: {
        basis: 'CURRENT_ACTIVE_CREDIT_PACKAGES',
        packages: 2,
        minPerCreditMinor: 1799,
        maxPerCreditMinor: 2495,
        lowValueMinor: 7196,
        highValueMinor: 9980,
      },
    },
    integrity: { zeroAllowancePlacements: 1, placementsWithoutGrant: 2, voidGrants: 0 },
    byPackage: [],
    byCategory: [],
    byProvider: { items: [], total: 0, page: 1, pageSize: 25, hasNextPage: false },
    cohortByPeriod: [],
    usageByPeriod: [],
    ...overrides,
  };
}

describe('formatting', () => {
  it('writes a missing value as N/A and never as ₺0', () => {
    expect(formatMinorOrNa(null)).toBe(NOT_AVAILABLE);
    expect(describeIndicativeValue({ usages: 1, credits: 2, valuedCredits: 0, unvaluedCredits: 2, indicativeValueMinor: null }).value).toBe(
      NOT_AVAILABLE,
    );
    const partial = describeIndicativeValue({ usages: 2, credits: 4, valuedCredits: 2, unvaluedCredits: 2, indicativeValueMinor: 4990 });
    expect(partial.value).toContain('49,90');
    expect(partial.note).toContain('2 kredi değerlenemedi');
  });

  it('names buckets and windows in Istanbul calendar words', () => {
    expect(formatBucket('2026-10', 'month')).toBe('Ekim 2026');
    expect(formatBucket('2026-10-01', 'day')).toBe('01.10.2026');
    expect(formatBucket('2026', 'year')).toBe('2026');
    expect(describeWindow({ from: null, to: null, groupBy: 'month', timezone: 'Europe/Istanbul' })).toBe('Tüm zamanlar');
    expect(describeWindow({ from: '2026-10-01', to: '2026-10-31', groupBy: 'month', timezone: 'Europe/Istanbul' })).toBe(
      '01.10.2026 – 31.10.2026',
    );
  });
});

describe('the TL card', () => {
  it('carries the agreed title and says the figure is not revenue', () => {
    const html = renderToStaticMarkup(<ValueSection report={reportWith()} />);
    expect(html).toContain(VALUE_SECTION_TITLE);
    expect(VALUE_SECTION_TITLE).toBe('Ücretsiz tekliflerin gösterge niteliğindeki TL karşılığı');
    expect(html).toContain(VALUE_DISCLAIMER);
    expect(VALUE_DISCLAIMER).toMatch(/gelir ya da kesin gelir kaybı değildir/);
  });

  it('shows N/A for an unvalued month and the list price only as a labelled reference', () => {
    const html = renderToStaticMarkup(<ValueSection report={reportWith()} />);
    expect(html).toMatch(/data-testid="allowance-indicative-value">N\/A</);
    expect(html).toContain('Güncel liste fiyatı referansı');
    expect(html).toContain(LIST_PRICE_DISCLAIMER);
    expect(html).toContain('71,96');
    expect(html).toContain('99,80');
  });
});

describe('unplaced rights and integrity', () => {
  it('says unplaced rights are not in the defined total, and why they vanish under a category filter', () => {
    const shown = renderToStaticMarkup(<UsageKpis usage={reportWith().usage} unplaced={reportWith().unplaced} />);
    expect(shown).toContain('Tanımlanan hakka eklenmez');
    const filtered = renderToStaticMarkup(<UsageKpis usage={reportWith().usage} unplaced={null} />);
    expect(filtered).toContain('Kategori filtresinde gösterilmez');
  });

  it('treats a 0-free-offer run as expected and names pre-allowance runs apart', () => {
    const html = renderToStaticMarkup(<MethodologySection report={reportWith()} />);
    expect(html).toContain('1 yayın 0 ücretsiz teklifle satıldı; hak kaydı olmaması beklenen durumdur.');
    expect(html).toContain('2 yayın hak sisteminden önce bitmişti');
  });
});

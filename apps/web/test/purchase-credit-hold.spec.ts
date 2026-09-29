import { describe, expect, it } from 'vitest';
import { purchaseCreditHoldView } from '../app/providers/[id]/package-purchases/credit-limit';

/**
 * API-HARDENING-001: a captured payment whose credit is held must read as
 * paid-and-waiting on the provider's screens, and never invite another
 * payment — while an ordinary purchase is untouched.
 */
const hold = (status: 'OPEN' | 'SETTLED' | 'REFUND_REPORTED') => ({
  creditHold: {
    status,
    chargedAmountMinor: 49900,
    currency: 'TRY',
    creditAmount: 25,
    openedAt: '2026-09-29T10:00:00.000Z',
    resolvedAt: status === 'OPEN' ? null : '2026-09-29T11:00:00.000Z',
  },
});

describe('purchaseCreditHoldView', () => {
  it('is null for a purchase without a hold, and for one whose hold settled', () => {
    expect(purchaseCreditHoldView({ creditHold: null })).toBeNull();
    expect(purchaseCreditHoldView({})).toBeNull();
    expect(purchaseCreditHoldView(hold('SETTLED'))).toBeNull();
  });

  it('says an open hold was paid, blocks payment and tells the provider not to buy again', () => {
    const view = purchaseCreditHoldView(hold('OPEN'))!;
    expect(view.blocksPayment).toBe(true);
    expect(view.label).toBe('Ödendi · kredi beklemede');
    expect(view.text).toContain('ödemeniz alındı');
    expect(view.text).toContain('yeniden satın almanıza gerek yok');
    expect(view.label).not.toMatch(/bekliyor|ödenmedi/i);
  });

  it('says a reported refund was refunded, with no credit', () => {
    const view = purchaseCreditHoldView(hold('REFUND_REPORTED'))!;
    expect(view.blocksPayment).toBe(true);
    expect(view.label).toBe('İade edildi');
    expect(view.text).toContain('kredi yüklenmedi');
  });
});

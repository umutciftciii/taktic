import { describe, expect, it } from 'vitest';
import { creditReasonLabel, creditTxnTypeLabel, refundSettlementSummary } from '../lib/formatters';

/**
 * CMP-004 S4 — what a provider reads about promotions on their own screens.
 *
 * The ledger stores machine codes (`CAMPAIGN_GRANT`, `PROMO_FORFEIT_ON_REFUND:EXPIRED`);
 * the provider's credit history must show words, and the refund line of an
 * offer must state the net when a promotion share was taken back — and say
 * exactly what it said before when none was.
 */

describe('creditTxnTypeLabel', () => {
  it('names the three campaign movements in Turkish and keeps the six original labels', () => {
    expect(creditTxnTypeLabel('CAMPAIGN_GRANT')).toBe('Promosyon kredisi');
    expect(creditTxnTypeLabel('CAMPAIGN_EXPIRE')).toBe('Promosyon süresi doldu');
    expect(creditTxnTypeLabel('CAMPAIGN_REVOKE')).toBe('Promosyon geri alındı');
    expect(creditTxnTypeLabel('OFFER_REFUND')).toBe('Teklif iadesi');
    expect(creditTxnTypeLabel('PACKAGE_PURCHASE')).toBe('Paket alımı');
  });
});

describe('creditReasonLabel', () => {
  it('translates the promotion reason codes, tail included, and never shows the raw code', () => {
    expect(creditReasonLabel('CAMPAIGN_GRANT')).toBe('Kampanya promosyon kredisi');
    expect(creditReasonLabel('PROMO_LOT_EXPIRED')).toBe('Promosyon kredisinin süresi doldu');
    expect(creditReasonLabel('PROMO_LOT_REVOKED:PAYMENT_REVERSED')).toBe('Promosyon geri alındı (ödeme iadesi)');
    expect(creditReasonLabel('PROMO_LOT_REVOKED:ADMIN_REVOKED')).toBe('Promosyon geri alındı');
    expect(creditReasonLabel('PROMO_FORFEIT_ON_REFUND:EXPIRED')).toBe(
      'Teklif iadesinde süresi dolmuş promosyon payı bakiyeye dönmedi',
    );
    expect(creditReasonLabel('PROMO_FORFEIT_ON_REFUND:REVOKED')).toBe(
      'Teklif iadesinde geri alınmış promosyon payı bakiyeye dönmedi',
    );
  });

  it('translates the refund policy codes and hides an operator note', () => {
    expect(creditReasonLabel('UNVIEWED_OFFER_48H')).toBe('Teklif iade süresi içinde görüntülenmedi');
    expect(creditReasonLabel('MANUAL_ADMIN_REFUND:INVALID_REQUEST')).toBe('Platform tarafından iade edildi');
  });

  it('leaves an unknown reason as it is, and an empty one as a dash', () => {
    expect(creditReasonLabel('Bir not')).toBe('Bir not');
    expect(creditReasonLabel(null)).toBe('-');
  });
});

describe('refundSettlementSummary', () => {
  const base = {
    refundTransactionId: 'r1',
    grossCredits: 5,
    promoRestoredCredits: 0,
    promoForfeitedCredits: { expired: 0, revoked: 0, total: 0 },
    netCredits: 5,
    balanceBefore: 0,
    balanceAfter: 5,
  };

  it('without a forfeit is the gross line the screen always showed', () => {
    expect(refundSettlementSummary(base)).toEqual({ headline: '+5 iade', detail: null });
    expect(refundSettlementSummary(null, 5)).toEqual({ headline: '+5 iade', detail: null });
  });

  it('with a forfeit states gross, the promotion taken back and the net', () => {
    expect(
      refundSettlementSummary({ ...base, promoForfeitedCredits: { expired: 3, revoked: 0, total: 3 }, netCredits: 2 }),
    ).toEqual({ headline: '+5 iade · −3 promosyon geri alındı · net +2', detail: 'Süresi dolmuş promosyon payı bakiyeye dönmedi.' });
    expect(
      refundSettlementSummary({ ...base, promoForfeitedCredits: { expired: 0, revoked: 3, total: 3 }, netCredits: 2 }).detail,
    ).toBe('Geri alınmış promosyon payı bakiyeye dönmedi.');
  });
});

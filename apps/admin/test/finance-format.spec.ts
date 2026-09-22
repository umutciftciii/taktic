import { describe, expect, it } from 'vitest';
import { formatLedgerReason, formatLedgerSource } from '../lib/finance-format';
import { CREDIT_TRANSACTION_TYPES, creditTxnTypeLabel } from '../lib/api';

/**
 * CMP-004 S4 — the admin ledger reads the campaign rows in Turkish.
 *
 * The stored reasons are codes with a `:` tail; for the promotion codes the
 * tail is part of the meaning (who revoked, why a share was forfeited), not
 * an operator's note, so it becomes part of the label and never a "Not:" line.
 */

describe('formatLedgerReason for campaign rows', () => {
  it('labels the grant and the expiry', () => {
    expect(formatLedgerReason('CAMPAIGN_GRANT')).toEqual({ label: 'Kampanya promosyon kredisi', note: null });
    expect(formatLedgerReason('PROMO_LOT_EXPIRED')).toEqual({ label: 'Promosyon süresi doldu', note: null });
  });

  it('folds the revoke source and the forfeit cause into the label', () => {
    expect(formatLedgerReason('PROMO_LOT_REVOKED:PAYMENT_REVERSED')).toEqual({
      label: 'Promosyon geri alındı (ödeme iadesi)',
      note: null,
    });
    expect(formatLedgerReason('PROMO_LOT_REVOKED:ADMIN_REVOKED')).toEqual({
      label: 'Promosyon geri alındı (yönetici)',
      note: null,
    });
    expect(formatLedgerReason('PROMO_FORFEIT_ON_REFUND:EXPIRED')).toEqual({
      label: 'Teklif iadesinde promosyon payı düştü (süresi dolmuş lot)',
      note: null,
    });
    expect(formatLedgerReason('PROMO_FORFEIT_ON_REFUND:REVOKED')).toEqual({
      label: 'Teklif iadesinde promosyon payı düştü (geri alınmış lot)',
      note: null,
    });
  });

  it('keeps the manual refund note behaviour it had', () => {
    expect(formatLedgerReason('MANUAL_ADMIN_REFUND:INVALID_REQUEST')).toEqual({
      label: 'Yönetici manuel kredi iadesi',
      note: 'INVALID_REQUEST',
    });
  });
});

describe('formatLedgerSource for campaign rows', () => {
  it('links the campaign by name and version when the row carries one', () => {
    expect(
      formatLedgerSource('PromoCreditLot', 'lot-1', null, { id: 'c1', name: 'Hoş geldin', versionNumber: 2 }),
    ).toEqual({
      label: 'Kampanya',
      displayNumber: 'Hoş geldin · sürüm 2',
      shortId: null,
      href: '/campaigns/c1',
      isSystem: false,
    });
  });

  it('falls back to the reference type label without a campaign', () => {
    expect(formatLedgerSource('CampaignRedemption', 'r1', null, null)).toMatchObject({
      label: 'Kampanya hak edişi',
      href: null,
      shortId: 'r1',
    });
    expect(formatLedgerSource('Offer', 'offer-1', '#O-1')).toMatchObject({ label: 'Teklif kaydı', href: '/offers/offer-1' });
  });
});

describe('the ledger type list', () => {
  it('offers the three campaign types beside the six originals, with labels', () => {
    expect(CREDIT_TRANSACTION_TYPES).toEqual([
      'PACKAGE_PURCHASE',
      'OFFER_SPEND',
      'OFFER_REFUND',
      'ADMIN_GRANT',
      'ADMIN_DEDUCT',
      'ADJUSTMENT',
      'CAMPAIGN_GRANT',
      'CAMPAIGN_EXPIRE',
      'CAMPAIGN_REVOKE',
    ]);
    expect(creditTxnTypeLabel('CAMPAIGN_GRANT')).toBe('Promosyon kredisi');
    expect(creditTxnTypeLabel('CAMPAIGN_EXPIRE')).toBe('Promosyon süresi doldu');
    expect(creditTxnTypeLabel('CAMPAIGN_REVOKE')).toBe('Promosyon geri alındı');
  });
});

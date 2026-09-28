import { describe, expect, it } from 'vitest';
import { isInModeration, isRemovable, moderationMove, removalUnavailableReason } from '../lib/request-moderation';

/**
 * The request screen's moderation buttons (PR #118 review, finding 2): only
 * the pre-market queue — SUBMITTED, IN_REVIEW, APPROVED — offers "İncelemeye
 * al" and "Onayla". Every status of every other flow offers neither.
 */
describe('request moderation moves', () => {
  it('offers both moves inside the queue, the current one as "Mevcut"', () => {
    expect(moderationMove('SUBMITTED', 'IN_REVIEW')).toBe('available');
    expect(moderationMove('SUBMITTED', 'APPROVED')).toBe('available');
    expect(moderationMove('IN_REVIEW', 'IN_REVIEW')).toBe('current');
    expect(moderationMove('IN_REVIEW', 'APPROVED')).toBe('available');
    expect(moderationMove('APPROVED', 'IN_REVIEW')).toBe('available');
    expect(moderationMove('APPROVED', 'APPROVED')).toBe('current');
  });

  it.each(['DRAFT', 'MATCHED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'])(
    'offers no move out of %s',
    (status) => {
      expect(isInModeration(status)).toBe(false);
      expect(moderationMove(status, 'IN_REVIEW')).toBe('hidden');
      expect(moderationMove(status, 'APPROVED')).toBe('hidden');
    },
  );

  it('treats an unknown status as outside the queue', () => {
    expect(moderationMove('SOMETHING_NEW', 'APPROVED')).toBe('hidden');
  });
});

/**
 * Why a request cannot be rejected or removed (PR #118 pre-merge fix). The
 * old hint sent every non-removable request to "İptal et", but the API
 * refuses a cancel on every closed status, and on a matched request a cancel
 * leaves the accepted offer, its credit and everyone's notification to open
 * product decisions (ADMIN-ACTIONS-005 K2–K5). No reason may present the
 * cancel as the rejection's substitute.
 */
describe('removal availability and its reason', () => {
  const RECOMMENDS_CANCEL = /(İptal et["”']?\s*(kullan|ile kaldır|yapın))|iptal edin/i;

  it.each(['SUBMITTED', 'IN_REVIEW', 'APPROVED'])('%s without a match is removable, with no reason', (status) => {
    expect(isRemovable(status, null)).toBe(true);
    expect(removalUnavailableReason(status, null)).toBeNull();
  });

  it.each(['SUBMITTED', 'IN_REVIEW', 'APPROVED'])(
    'an open %s row that still carries a match is not removable (API REQUEST_NOT_REMOVABLE)',
    (status) => {
      expect(isRemovable(status, 'offer-1')).toBe(false);
      expect(removalUnavailableReason(status, 'offer-1')).toBe(removalUnavailableReason('MATCHED', 'offer-1'));
    },
  );

  it.each(['COMPLETED', 'CANCELLED', 'EXPIRED'])('%s: closed, and says a cancel is not possible either', (status) => {
    const reason = removalUnavailableReason(status, null);
    expect(reason).toContain('Kapanmış talep reddedilemez');
    expect(reason).not.toMatch(RECOMMENDS_CANCEL);
    expect(reason).not.toContain('“İptal et”');
  });

  it('CANCELLED says it cannot be reopened', () => {
    expect(removalUnavailableReason('CANCELLED', null)).toContain('yeniden açılamaz');
  });

  it('REJECTED points only at the report reopen path', () => {
    const reason = removalUnavailableReason('REJECTED', null);
    expect(reason).toContain('zaten reddedilmiş');
    expect(reason).toContain('Şikayet sekmesinden geri açılabilir');
    expect(reason).not.toContain('İptal');
  });

  it('MATCHED names the operations cancel with its decided consequences, and that the customer cannot', () => {
    const reason = removalUnavailableReason('MATCHED', 'offer-1') ?? '';
    expect(reason).toContain('eşleşmiş talep reddedilemez');
    expect(reason).toContain('iptal yetkisi olan yöneticinin');
    expect(reason).toContain('kazanan teklifin kredisi varsayılan olarak iade edilir');
    expect(reason).toContain('iadesiz iptal ayrı yetki ve gerekçe ister');
    expect(reason).toContain('Müşteri eşleşmiş talebi iptal edemez');
    // The pre-contract wording must not come back.
    expect(reason).not.toContain('kabul edilmiş kalır');
    expect(reason).not.toContain('ürün kararı bekliyor');
    expect(reason).not.toMatch(RECOMMENDS_CANCEL);
  });

  // PR #118 review, item 6: a closed request that still carries its match
  // is answered as closed — never "matched, can be cancelled".
  it.each(['COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED'])(
    '%s with a matchedOfferId is answered as closed, not as matched',
    (status) => {
      const reason = removalUnavailableReason(status, 'offer-1') ?? '';
      expect(reason).toBe(removalUnavailableReason(status, null));
      expect(reason).not.toContain('eşleşmiş talep reddedilemez');
      expect(reason).not.toContain('“İptal et”');
    },
  );

  it('DRAFT: not removable, takes no offers', () => {
    const reason = removalUnavailableReason('DRAFT', null);
    expect(reason).toContain('taslak');
    expect(reason).toContain('teklif almadığı');
    expect(reason).toContain('İptal yetkisi olan yönetici');
  });
});

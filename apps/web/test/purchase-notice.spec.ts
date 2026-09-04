import { describe, expect, it } from 'vitest';
import type { PackagePurchaseStatus } from '../lib/api';
import { noticeForStatus } from '../app/providers/[id]/package-purchases/purchase-notice';

/**
 * What the purchase screen is allowed to promise.
 *
 * A settled purchase used to be answered with "Bu işleme ait e-fatura,
 * sistemde kayıtlı e-posta adresinize iletilecektir." Nothing in this product
 * issues an invoice: there is no e-fatura integration, no e-arşiv integration
 * and no document of any kind produced by a settlement. The sentence described
 * something that never happened, and a provider waiting for it had no way to
 * find that out.
 *
 * What a settlement really produces is the confirmation e-mail, so that is what
 * the banner now describes — and it describes it as a send, not as a delivery,
 * because a transport failure is possible and the credits are loaded either
 * way.
 */

const EVERY_STATUS: PackagePurchaseStatus[] = [
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

describe('noticeForStatus', () => {
  it('promises no invoice of any kind, in any state', () => {
    for (const status of EVERY_STATUS) {
      const notice = noticeForStatus(status, null);
      const text = `${notice?.title ?? ''} ${notice?.body ?? ''}`.toLocaleLowerCase('tr-TR');

      expect(text).not.toContain('fatura');
      expect(text).not.toContain('e-arşiv');
      expect(text).not.toContain('e-arsiv');
      expect(text).not.toContain('makbuz');
      expect(text).not.toContain('dekont');
    }
  });

  it('tells a settled purchase about the confirmation e-mail it really sends', () => {
    const notice = noticeForStatus('PAID', null);

    expect(notice?.body).toContain('onay e-postası');
    expect(notice?.body).toContain('hesabınıza kayıtlı e-posta');
    // The credits are the fact; the e-mail is an attempt. The copy must not
    // make the second sound as certain as the first.
    expect(notice?.body).toContain('E-posta ulaşmasa da');
    expect(notice?.body).toContain('kredi geçmişinizden');
    expect(notice?.body).not.toContain('iletilecektir');
  });

  it('still says what every other state means', () => {
    expect(noticeForStatus('PENDING', null)?.title).toBe('Ödeme bekleniyor');
    expect(noticeForStatus('FAILED', null)?.tone).toBe('error');
    expect(noticeForStatus('FAILED', 'Kart limiti yetersiz')?.body).toContain(
      'Kart limiti yetersiz',
    );
    expect(noticeForStatus('CANCELLED', null)?.title).toBe('Sipariş iptal edildi');
    expect(noticeForStatus('EXPIRED', null)?.title).toBe('Sipariş süresi doldu');
    expect(noticeForStatus('REFUNDED', null)?.title).toBe('İade tamamlandı');
  });
});

import type { PackagePurchaseStatus } from '../../../../lib/api';

/**
 * The standing banner on a purchase, as a plain function.
 *
 * It lives beside the screen rather than inside it so the copy can be asserted
 * without a browser. That matters here specifically: this banner used to
 * promise an e-fatura, and there is no invoicing integration of any kind behind
 * this product — no e-fatura, no e-arşiv, nothing that produces a document.
 * A test that can read the strings is what keeps that promise from coming back.
 */
export type NoticeTone = 'default' | 'warn' | 'error';

export type Notice = {
  tone: NoticeTone;
  icon: string;
  title: string;
  body: string;
};

export function noticeForStatus(
  status: PackagePurchaseStatus,
  failureReason: string | null,
): Notice | null {
  switch (status) {
    case 'PAID':
      return {
        tone: 'default',
        icon: 'i',
        title: 'Bilgilendirme',
        // This used to promise an e-fatura. There is no invoicing integration
        // of any kind behind this screen, so the sentence described something
        // that never happened. What the platform really does on a settled
        // purchase is send the confirmation e-mail below — stated as an
        // attempt, not as a delivery guarantee, because a send can fail and
        // the credits are loaded either way.
        body: 'Bu satın alma için hesabınıza kayıtlı e-posta adresine bir onay e-postası gönderilir. E-posta ulaşmasa da paketiniz hesabınıza yüklenmiştir; işlemi kredi geçmişinizden takip edebilirsiniz.',
      };
    case 'PENDING':
      return {
        tone: 'warn',
        icon: '·',
        title: 'Ödeme bekleniyor',
        body: 'Ödeme tamamlanmadı. İşleme ödeme ekranından devam edebilirsiniz.',
      };
    case 'FAILED':
      return {
        tone: 'error',
        icon: '⚠',
        title: 'Ödeme başarısız',
        body: failureReason
          ? `Kart işlemi tamamlanamadı. Sebep: ${failureReason}. Yeni bir paket satın alma işlemi başlatarak tekrar deneyebilirsiniz.`
          : 'Kart işlemi tamamlanamadı. Yeni bir paket satın alma işlemi başlatarak tekrar deneyebilirsiniz.',
      };
    case 'CANCELLED':
      return {
        tone: 'default',
        icon: 'i',
        title: 'Sipariş iptal edildi',
        body: 'Bu sipariş iptal edilmiştir. Yeni bir paket satın almak için Kredilerim sayfasını ziyaret edebilirsiniz.',
      };
    case 'EXPIRED':
      return {
        tone: 'default',
        icon: 'i',
        title: 'Sipariş süresi doldu',
        body: 'Bu siparişin geçerlilik süresi dolmuştur. Yeni bir paket satın alabilirsiniz.',
      };
    case 'REFUNDED':
      return {
        tone: 'default',
        icon: 'i',
        title: 'İade tamamlandı',
        body: 'Bu satın alma için iade işlemi tamamlanmıştır.',
      };
    default:
      return null;
  }
}

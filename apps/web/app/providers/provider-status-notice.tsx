import Link from 'next/link';
import type { ProviderStatus } from '../../lib/api';

/**
 * What a provider is told about their own account's status, on their panel.
 *
 * PROVIDER-STATUS-001: no reason. A rejection or suspension reason is the
 * operator's record of a decision — it stays on the admin screens and in the
 * status history, and the provider's own API projection does not carry it.
 * The wording is deliberately general and neutral: it says what the account
 * can and cannot do now and where to ask, and never what anybody did.
 */
export function ProviderStatusNotice({ status }: { status: ProviderStatus }) {
  if (status === 'PENDING_REVIEW') {
    return (
      <div className="pdash-notice" data-testid="provider-status-notice">
        Başvurunuz inceleniyor. Onaylandıktan sonra uygun taleplere teklif verebilirsiniz.
      </div>
    );
  }

  if (status === 'REJECTED') {
    return (
      <div className="pdash-notice pdash-notice-error" role="status" data-testid="provider-status-notice">
        Başvurunuz şu aşamada onaylanmadı. Sorularınız veya yeniden değerlendirme talebiniz için{' '}
        <Link href="/destek">Destek</Link> üzerinden bize yazabilirsiniz.
      </div>
    );
  }

  if (status === 'SUSPENDED') {
    return (
      <div className="pdash-notice pdash-notice-warn" role="status" data-testid="provider-status-notice">
        Hesabınız şu anda yeni iş almaya kapalı: yeni talepleri göremez ve teklif veremezsiniz. Kabul edilmiş
        işleriniz ve bu işlerdeki mesajlaşmanız devam eder. Bilgi veya inceleme talebi için{' '}
        <Link href="/destek">Destek</Link> üzerinden bize yazabilirsiniz.
      </div>
    );
  }

  return null;
}

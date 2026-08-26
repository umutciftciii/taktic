import { redirect } from 'next/navigation';
import Link from 'next/link';
import { IconArrowLeft } from '../../../../landing-icons';
import {
  apiFetch,
  getCurrentUser,
  PackagePurchase,
  PackagePurchaseStatus,
  statusLabel,
  formatPrice,
  formatDateTime,
} from '../../../../../lib/api';
import { ProviderShell } from '../../../provider-shell';
import { providerStatusBadgeClass } from '../../../provider-ui';

type ProviderPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string; purchaseId: string }>;
  searchParams: Promise<{ checkout?: string }>;
};

/**
 * How the provider got here, as far as the URL is concerned.
 *
 * `return` is what the hosted checkout page redirects to and `cancel` is what
 * it uses when the provider backed out. Both are cosmetic: the screen below
 * always renders the canonical status the API reports, so a hand-typed
 * `?checkout=return` shows exactly what the purchase actually is.
 */
type CheckoutOutcome = 'return' | 'cancel' | null;

type TimelineTone = 'default' | 'success' | 'warn' | 'danger';

type TimelineEvent = {
  key: string;
  title: string;
  description?: string;
  timestamp: string;
  tone: TimelineTone;
};

type NoticeTone = 'default' | 'warn' | 'error';

type Notice = {
  tone: NoticeTone;
  icon: string;
  title: string;
  body: string;
};

export default async function ProviderPackagePurchaseDetailPage({
  params,
  searchParams,
}: ProviderPackagePurchaseDetailPageProps) {
  const { id, purchaseId } = await params;
  const { checkout } = await searchParams;
  const outcome: CheckoutOutcome =
    checkout === 'return' ? 'return' : checkout === 'cancel' ? 'cancel' : null;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/package-purchases/${purchaseId}`);
  }

  const purchase = await apiFetch<PackagePurchase>(`/providers/${id}/package-purchases/${purchaseId}`);

  const timeline = buildTimeline(purchase);
  const notice = noticeForStatus(purchase.status, purchase.mockPaymentFailureReason);
  // Read from the purchase the API just returned, never from the query string.
  const outcomeNotice = checkoutOutcomeNotice(outcome, purchase.status);
  const hostedCheckoutUrl =
    purchase.status === 'PENDING' ? purchase.providerCheckoutUrl : null;
  const title = purchase.packageNameSnapshot || 'Paket Satın Alma';
  const referenceText =
    purchase.purchaseNumber ?? purchase.mockPaymentReference ?? '—';

  return (
    <ProviderShell user={user} providerId={id} active="packages">
      <header className="pdash-page-head">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <Link
              className="pdash-back-icon"
              href={`/providers/${id}/package-purchases`}
              aria-label="Paket Geçmişine Dön"
              title="Paket Geçmişine Dön"
            >
              <IconArrowLeft size={16} />
            </Link>
            <h1 className="pdash-page-title" style={{ margin: 0 }}>
              {title}
            </h1>
          </div>
          <span
            className={providerStatusBadgeClass(purchase.status)}
            data-testid="purchase-status"
          >
            {statusLabel(purchase.status)}
          </span>
        </div>
        <p className="pdash-page-sub" style={{ marginTop: 6 }}>
          {formatDateTime(purchase.createdAt)}
        </p>
      </header>

      {outcomeNotice ? (
        <div
          className={`pdash-info-banner${outcomeNotice.tone === 'warn' ? ' is-warn' : ''}`}
          data-testid="checkout-outcome"
        >
          <span className="pdash-info-banner-icon" aria-hidden="true">
            {outcomeNotice.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <p className="pdash-info-banner-title">{outcomeNotice.title}</p>
            <p className="pdash-info-banner-body">{outcomeNotice.body}</p>
          </div>
        </div>
      ) : null}

      <section className="pdash-detail-card">
        <h2>Sipariş Detayları</h2>
        <div className="pdash-metric-grid">
          <div>
            <p className="pdash-metric-label">Tutar</p>
            <p className="pdash-metric-value">
              {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
            </p>
          </div>
          <div>
            <p className="pdash-metric-label">Kredi Miktarı</p>
            <p className="pdash-metric-value">{purchase.creditAmountSnapshot} Kredi</p>
          </div>
          <div>
            <p className="pdash-metric-label">Referans No</p>
            <p
              className="pdash-metric-value"
              style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 600 }}
            >
              {referenceText}
            </p>
          </div>
          {purchase.creditTransactionId ? (
            <div>
              <p className="pdash-metric-label">Kredi İşlem Kaydı</p>
              <p
                className="pdash-metric-value"
                style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}
              >
                {purchase.creditTransactionId}
              </p>
            </div>
          ) : null}
        </div>
        {purchase.providerNote ? (
          <>
            <div style={{ borderTop: '1px solid var(--border-2)', marginTop: 4 }} />
            <div>
              <p className="pdash-metric-label">Not</p>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {purchase.providerNote}
              </p>
            </div>
          </>
        ) : null}
      </section>

      <section className="pdash-detail-card">
        <h2>İşlem Geçmişi</h2>
        <div className="pdash-timeline">
          {timeline.map((event) => (
            <div className="pdash-timeline-item" key={event.key}>
              <span className={`pdash-timeline-dot is-${event.tone}`} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <h3 className="pdash-timeline-title">{event.title}</h3>
                {event.description ? (
                  <p className="pdash-timeline-sub">{event.description}</p>
                ) : null}
              </div>
              <span className="pdash-timeline-meta">{formatDateTime(event.timestamp)}</span>
            </div>
          ))}
        </div>
      </section>

      {notice ? (
        <div
          className={`pdash-info-banner${
            notice.tone === 'warn'
              ? ' is-warn'
              : notice.tone === 'error'
                ? ' is-error'
                : ''
          }`}
        >
          <span className="pdash-info-banner-icon" aria-hidden="true">
            {notice.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <p className="pdash-info-banner-title">{notice.title}</p>
            <p className="pdash-info-banner-body">{notice.body}</p>
          </div>
        </div>
      ) : null}

      <div className="pdash-page-footer">
        <Link className="pdash-btn pdash-btn-ghost" href={`/providers/${id}/package-purchases`}>
          Paket Geçmişine Dön
        </Link>
        <div className="pdash-actions">
          {purchase.status === 'PAID' ? (
            <span
              className="pdash-btn pdash-btn-secondary"
              role="button"
              aria-disabled="true"
              title="Yakında"
            >
              <span aria-hidden="true">⬇</span> Faturayı İndir
            </span>
          ) : null}
          {purchase.status === 'PENDING' ? (
            <Link
              className="pdash-btn pdash-btn-primary"
              // The hosted page when the purchase was opened against one,
              // otherwise the in-app mock checkout. Following either changes
              // nothing on its own.
              href={
                hostedCheckoutUrl ?? `/providers/${id}/package-purchases/${purchase.id}/checkout`
              }
            >
              Test Ödemesine Devam Et
            </Link>
          ) : null}
          {purchase.status === 'FAILED' ||
          purchase.status === 'CANCELLED' ||
          purchase.status === 'EXPIRED' ? (
            <Link className="pdash-btn pdash-btn-primary" href={`/providers/${id}/credits`}>
              Kredilerim &amp; Paketler
            </Link>
          ) : null}
        </div>
      </div>
    </ProviderShell>
  );
}

function buildTimeline(p: PackagePurchase): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      key: 'created',
      title: 'Sipariş Oluşturuldu',
      description: 'Sistem üzerinden paket seçimi yapıldı.',
      timestamp: p.createdAt,
      tone: 'default',
    },
  ];

  if (p.paidAt) {
    events.push({
      key: 'paid',
      title: 'Ödeme Onaylandı',
      description: 'Kart işleminiz başarıyla gerçekleşti.',
      timestamp: p.paidAt,
      tone: 'success',
    });
  }

  if (p.creditTransactionId && (p.paidAt || p.status === 'PAID')) {
    const description = `${p.creditAmountSnapshot} kredi bakiyenize eklendi. İşlem No: ${p.creditTransactionId}`;
    events.push({
      key: 'credit-loaded',
      title: 'Kredi Hesaba Tanımlandı',
      description,
      timestamp: p.paidAt ?? p.updatedAt,
      tone: 'success',
    });
  }

  if (p.failedAt) {
    events.push({
      key: 'failed',
      title: 'Ödeme Başarısız',
      description: p.mockPaymentFailureReason ?? 'Ödeme banka tarafından reddedildi.',
      timestamp: p.failedAt,
      tone: 'danger',
    });
  }

  if (p.cancelledAt) {
    events.push({
      key: 'cancelled',
      title: 'Sipariş İptal Edildi',
      timestamp: p.cancelledAt,
      tone: 'warn',
    });
  }

  if (p.expiredAt) {
    events.push({
      key: 'expired',
      title: 'Sipariş Süresi Doldu',
      timestamp: p.expiredAt,
      tone: 'warn',
    });
  }

  if (p.refundedAt) {
    events.push({
      key: 'refunded',
      title: 'İade Edildi',
      timestamp: p.refundedAt,
      tone: 'warn',
    });
  }

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events;
}

function noticeForStatus(
  status: PackagePurchaseStatus,
  failureReason: string | null,
): Notice | null {
  switch (status) {
    case 'PAID':
      return {
        tone: 'default',
        icon: 'i',
        title: 'Bilgilendirme',
        body: 'Bu işleme ait e-fatura, sistemde kayıtlı e-posta adresinize iletilecektir.',
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

/**
 * The banner that acknowledges coming back from a hosted checkout page.
 *
 * It reports the status the API just returned and nothing else. Returning from
 * a payment page is a navigation: it proves the provider's browser was
 * somewhere, not that anybody paid, so this screen must never turn a redirect
 * into "ödeme başarılı". Credits are loaded by a signature-verified webhook and
 * only by one, which is why a purchase that is still PENDING here says so.
 */
function checkoutOutcomeNotice(
  outcome: CheckoutOutcome,
  status: PackagePurchaseStatus,
): Notice | null {
  if (!outcome) {
    return null;
  }

  if (outcome === 'cancel') {
    return {
      tone: 'warn',
      icon: '↩',
      title: 'Ödeme tamamlanmadı',
      body: 'Test ödeme sayfasından ayrıldınız. Bu satın alma için kredi yüklenmedi.',
    };
  }

  if (status === 'PAID') {
    return {
      tone: 'default',
      icon: '✓',
      title: 'Ödeme doğrulandı',
      body: 'Test ödemesi sağlayıcı bildirimiyle doğrulandı ve krediniz hesabınıza yüklendi.',
    };
  }

  if (status === 'PENDING') {
    return {
      tone: 'warn',
      icon: '·',
      title: 'Ödeme doğrulanmayı bekliyor',
      body:
        'Ödeme sayfasından döndünüz. Kredi yalnızca sağlayıcının doğrulanmış ödeme bildirimi ' +
        'ulaştığında yüklenir; bu sayfa durumu her açılışta yeniden okur.',
    };
  }

  return {
    tone: 'warn',
    icon: 'i',
    title: 'Ödeme tamamlanmadı',
    body: 'Bu satın alma ödeme almadı ve kredi yüklenmedi.',
  };
}

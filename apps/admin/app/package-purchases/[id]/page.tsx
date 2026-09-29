import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  PackagePurchase,
  PURCHASE_CREDIT_HOLD_LABELS,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { updatePackagePurchaseStatusAction } from '../actions';
import { CREDIT_AMOUNT_MAX } from '../../../lib/credit-amount';
import { formatCount } from '../../../lib/pagination';

type AdminPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminPackagePurchaseDetailPage({ params }: AdminPackagePurchaseDetailPageProps) {
  const { can } = await requireAdmin('PACKAGE_PURCHASES_READ');
  const canFixStatus = can('PACKAGE_PURCHASE_STATUS_WRITE');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const canOpenCredits = can('FINANCE_LEDGER_READ');
  const { id } = await params;
  const purchase = await fetchOrNotFound(() =>
    apiFetch<PackagePurchase>(`/package-purchases/${encodeURIComponent(id)}`),
  );
  const purchaseRef = purchase.purchaseNumber ?? `#${purchase.id.slice(-8)}`;
  const hold = purchase.creditHold;
  const holdOpen = hold?.status === 'OPEN';

  return (
    <main>
      <p className="breadcrumbs">
        {can('DASHBOARD_READ') ? <Link href="/">Dashboard</Link> : <span>Dashboard</span>}
        <span aria-hidden="true">/</span>
        <Link href="/package-purchases">Paket talepleri</Link>
        <span aria-hidden="true">/</span>
        <span>Detay</span>
      </p>

      <header className="page-header">
        <h1 className="page-title">{purchase.packageNameSnapshot}</h1>
        <p className="page-subtitle">
          <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>{' '}
          <span className="muted">· <code>{purchaseRef}</code> · {purchase.provider.businessName}</span>
        </p>
      </header>

      {canOpenProvider || canOpenCredits ? (
        <div className="inline-actions" style={{ marginBottom: 18 }}>
          {canOpenProvider ? (
            <Link className="btn btn-secondary btn-sm" href={`/providers/${purchase.providerId}`}>
              Hizmet vereni aç
            </Link>
          ) : null}
          {canOpenCredits ? (
            <Link className="btn btn-ghost btn-sm" href={`/providers/${purchase.providerId}/credits`}>
              Kredi geçmişi
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="stack">
          <section className="card" style={{ margin: 0 }}>
            <h2>Özet</h2>
            <dl className="meta-row">
              <dt>Satın Alma No</dt>
              <dd>
                <code>{purchaseRef}</code>
                {purchase.purchaseNumber ? (
                  <details className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                    <summary>Teknik ID</summary>
                    <code style={{ fontSize: 11 }}>{purchase.id}</code>
                  </details>
                ) : null}
              </dd>
              <dt>Hizmet Veren</dt>
              <dd>{purchase.provider.businessName}</dd>
              <dt>HV e-posta</dt>
              <dd>{purchase.provider.email ?? '-'}</dd>
              <dt>Paket</dt>
              <dd>{purchase.packageNameSnapshot}</dd>
              <dt>Kredi</dt>
              <dd>{purchase.creditAmountSnapshot}</dd>
              <dt>Tutar</dt>
              <dd><strong>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</strong></dd>
            </dl>
          </section>

          {hold ? (
            /*
             * API-HARDENING-001. The money and the credit disagree: the
             * provider's order was captured, the credit was not delivered
             * because it would pass the ledger bound. This card is where an
             * operator reads the gap and how it can close — nothing here
             * refunds or loads anything.
             */
            <section className="card" style={{ margin: 0 }} data-testid="purchase-credit-hold-card">
              <h2>Tahsilat · kredi teslimi</h2>
              <p>
                <span className={holdOpen ? 'badge badge-warn' : 'badge'}>{PURCHASE_CREDIT_HOLD_LABELS[hold.status]}</span>
              </p>
              <dl className="meta-row">
                <dt>Tahsil edilen</dt>
                <dd>
                  <strong>{formatPrice(hold.chargedAmountMinor, hold.currency)}</strong>
                </dd>
                <dt>Teslim edilecek kredi</dt>
                <dd>{formatCount(hold.creditAmount)}</dd>
                <dt>Teslim edilen kredi</dt>
                <dd>{hold.status === 'SETTLED' ? formatCount(hold.creditAmount) : '0'}</dd>
                <dt>Sağlayıcı sipariş no</dt>
                <dd>
                  <code>{hold.providerOrderId ?? '-'}</code>
                </dd>
                <dt>Vaka açıldığında bakiye</dt>
                <dd>
                  {hold.balanceAtOpen !== undefined ? formatCount(hold.balanceAtOpen) : '-'} (üst sınır{' '}
                  {formatCount(CREDIT_AMOUNT_MAX)})
                </dd>
                <dt>Reddedilen teslimat</dt>
                <dd>
                  {hold.refusedDeliveries ?? '-'}
                  {hold.lastRefusedAt ? ` · son ${formatDateTime(hold.lastRefusedAt)}` : ''}
                </dd>
                <dt>Açıldı</dt>
                <dd>{formatDateTime(hold.openedAt)}</dd>
                <dt>Kapandı</dt>
                <dd>
                  {hold.resolvedAt
                    ? `${formatDateTime(hold.resolvedAt)}${hold.resolvedEvent ? ` · ${hold.resolvedEvent.eventName}` : ''}`
                    : 'hayır'}
                </dd>
              </dl>
              {holdOpen ? (
                <div className="notice-warning" data-testid="purchase-credit-hold-steps">
                  <strong>Otomatik iade yapılmaz.</strong> İki çözüm yolu var ve karar yetkili personelindir:
                  <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                    <li>
                      Hizmet verenin bakiyesi bu kredi için yeterince düştüyse Lemon Squeezy panelinden bu siparişin
                      ödeme bildirimini yeniden gönderin: kredi yüklenir, satın alma “Ödendi” olur ve vaka kendiliğinden
                      “Kredi sonradan teslim edildi” olarak kapanır.
                    </li>
                    <li>
                      İade kararı verilirse iadeyi Lemon Squeezy panelinden yapın: gelen iade bildirimi vakayı “Ödeme
                      iade edildi” olarak kapatır ve bu sipariş bir daha krediye dönüşmez.
                    </li>
                  </ol>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="card" style={{ margin: 0 }}>
            <h2>Zaman çizgisi</h2>
            <dl className="meta-row">
              <dt>Oluşturulma</dt>
              <dd>{formatDateTime(purchase.createdAt)}</dd>
              <dt>Ödendi</dt>
              <dd>{purchase.paidAt ? formatDateTime(purchase.paidAt) : '-'}</dd>
              <dt>Başarısız</dt>
              <dd>{purchase.failedAt ? formatDateTime(purchase.failedAt) : '-'}</dd>
              <dt>İptal</dt>
              <dd>{purchase.cancelledAt ? formatDateTime(purchase.cancelledAt) : '-'}</dd>
              <dt>Süre dolumu</dt>
              <dd>{purchase.expiredAt ? formatDateTime(purchase.expiredAt) : '-'}</dd>
            </dl>
          </section>

          <section className="card" style={{ margin: 0 }}>
            <h2>Notlar ve referanslar</h2>
            <dl className="meta-row">
              <dt>Ödeme sağlayıcı</dt>
              <dd>
                <code>{purchase.paymentProvider ?? 'mock'}</code>{' '}
                <span className="badge badge-warn">test</span>
              </dd>
              <dt>Ödeme Referansı</dt>
              <dd>{purchase.mockPaymentReference ?? '-'}</dd>
              {/*
                Opaque provider-side identifiers only. The correlation token this
                application mints is deliberately not shown anywhere: it is the
                value a webhook has to match, so it stays out of screens, logs
                and API responses that are not the purchase's own.
              */}
              <dt>Sağlayıcı sipariş no</dt>
              <dd>{purchase.providerOrderId ?? '-'}</dd>
              <dt>Sağlayıcı ödeme oturumu</dt>
              <dd>{purchase.providerCheckoutId ?? '-'}</dd>
              <dt>Başarısızlık sebebi</dt>
              <dd className="muted">
                {purchase.mockPaymentFailureReason ?? purchase.paymentFailureCode ?? '-'}
              </dd>
              <dt>Manuel inceleme</dt>
              <dd className="muted">
                {purchase.manualReviewAt
                  ? `${purchase.manualReviewReason ?? 'Gerekli'} · ${formatDateTime(purchase.manualReviewAt)} — sağlayıcıdan iade/ters ibraz bildirimi geldi. Otomatik kredi düşülmedi.`
                  : '-'}
              </dd>
              {/*
                The settlement notices themselves. A refusal and the redelivery
                that later settled it are one event, so an operator otherwise
                sees only the end state and cannot tell a purchase that
                recovered from one that never stumbled.
              */}
              <dt>Sağlayıcı bildirimleri</dt>
              <dd className="muted">
                {purchase.webhookEvents?.length
                  ? purchase.webhookEvents.map((attempt, index) => (
                      <div key={`${attempt.eventName}-${index}`}>
                        <code>{attempt.eventName}</code> · {attempt.status}
                        {attempt.detail ? ` (${attempt.detail})` : ''} ·{' '}
                        {attempt.attemptCount === 1
                          ? '1 teslimat'
                          : `${attempt.attemptCount} teslimat`}
                        <br />
                        İlk hata:{' '}
                        {attempt.firstFailureCode
                          ? `${attempt.firstFailureCode}${
                              attempt.firstFailureAt
                                ? ` · ${formatDateTime(attempt.firstFailureAt)}`
                                : ''
                            }`
                          : '-'}
                        <br />
                        Son deneme: {formatDateTime(attempt.lastAttemptAt)}
                        <br />
                        Çözüldü:{' '}
                        {attempt.resolvedAt ? formatDateTime(attempt.resolvedAt) : 'hayır'}
                        {/*
                          API-HARDENING-001: a genuine, matching order refused
                          because its credits would pass the ledger's integer
                          bound. Nothing was written; the next delivery is
                          judged again.
                        */}
                        {attempt.status === 'MISMATCHED' && attempt.detail === 'CREDIT_BALANCE_LIMIT_EXCEEDED' ? (
                          <div className="notice-warning" data-testid="webhook-credit-limit-note" style={{ marginTop: 6 }}>
                            Ödeme doğrulandı ama kredileri bakiyenin üst sınırını ({formatCount(CREDIT_AMOUNT_MAX)}) aşacağı için
                            yüklenmedi. Kısmi kredi yazılmadı, satın alma “Bekliyor” durumunda kaldı ve “Tahsilat ·
                            kredi teslimi” vakası açıldı; çözüm yolları o kartta.
                          </div>
                        ) : null}
                      </div>
                    ))
                  : '-'}
              </dd>
              <dt>Kredi işlemi</dt>
              <dd>{purchase.creditTransactionId ?? '-'}</dd>
              <dt>HV notu</dt>
              <dd className="muted">{purchase.providerNote ?? '-'}</dd>
              <dt>Yönetici notu</dt>
              <dd className="muted">{purchase.adminNote ?? '-'}</dd>
            </dl>
          </section>
        </div>

        <div className="stack">
          {holdOpen ? (
            <div className="notice" data-testid="purchase-credit-hold-no-manual-fix">
              Bu satın almanın ödemesi tahsil edildi; iptal veya “Süresi doldu” olarak işaretlenemez. Vaka, kredi
              teslimi ya da bildirilen iade ile kapanır.
            </div>
          ) : purchase.status === 'PENDING' && !canFixStatus ? null : purchase.status === 'PENDING' ? (
            <section className="card" style={{ margin: 0 }}>
              <h2>Manuel düzeltme</h2>
              <div className="notice-warning">
                Yönetici düzeltmesi sadece <strong>İptal</strong> veya <strong>Süresi doldu</strong>'yu
                destekler ve kredi kazandırmaz.
              </div>
              <form action={updatePackagePurchaseStatusAction} style={{ display: 'grid', gap: 12 }}>
                <input type="hidden" name="id" value={purchase.id} />
                <label className="form-row">
                  <span>Durum</span>
                  <select name="status" defaultValue="CANCELLED">
                    <option value="CANCELLED">İptal</option>
                    <option value="EXPIRED">Süresi doldu</option>
                  </select>
                </label>
                <label className="form-row">
                  <span>Yönetici notu</span>
                  <textarea name="adminNote" />
                </label>
                <div>
                  <button className="btn btn-primary btn-block" type="submit">Durumu güncelle</button>
                </div>
              </form>
            </section>
          ) : (
            <div className="notice">
              Bu talep <strong>{statusLabel(purchase.status)}</strong> durumunda. Manuel düzeltme yapılamaz.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

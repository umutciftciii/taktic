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
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { DetailHeader } from '../../../components/detail-header';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import type { SummaryItem } from '../../../components/summary-strip';
import { PurchaseStatusConsequence } from './purchase-status-consequence';

type AdminPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * One package purchase: what was sold, what the payment provider said about
 * it, and — while it is still pending — the one correction an operator may
 * make.
 *
 * ADMIN-DESIGN-001 Faz 3D: the design has no screen for one purchase (`soon`),
 * so it sits on the shared detail template — summary card and strip, then the
 * cards the old screen had, unchanged in content:
 *
 * - "Tahsilat · kredi teslimi" (API-HARDENING-001): charged amount, credits to
 *   deliver, credits delivered, the hold's OPEN / SETTLED / REFUND_REPORTED
 *   state and, while OPEN, the two ways it can close. Nothing here refunds or
 *   loads anything.
 * - The provider's settlement notices, one per event, with the first refusal
 *   kept after a later delivery settled it.
 * - "Manuel düzeltme": PENDING only, PACKAGE_PURCHASE_STATUS_WRITE only, and
 *   never while a credit hold is OPEN — that purchase was paid, and the API
 *   refuses the write (PURCHASE_CREDIT_HOLD_OPEN) even if a form reached it.
 *   The two outcomes are now two buttons, each asking first; the note and the
 *   `status` field sent are the same as before.
 */
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
  const price = formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot);

  const facts: SummaryItem[] = [
    { label: 'Tutar', value: price, testId: 'purchase-fact-amount' },
    { label: 'Kredi', value: formatCount(purchase.creditAmountSnapshot), testId: 'purchase-fact-credits' },
    {
      label: 'Ödeme',
      value: statusLabel(purchase.status),
      note: purchase.paidAt ? formatDateTime(purchase.paidAt) : undefined,
      tone: purchase.status === 'PAID' ? 'success' : purchase.status === 'PENDING' ? 'warning' : 'neutral',
    },
    ...(hold
      ? [
          {
            label: 'Kredi teslimi',
            value: PURCHASE_CREDIT_HOLD_LABELS[hold.status],
            tone: holdOpen ? ('warning' as const) : ('neutral' as const),
          },
        ]
      : []),
    { label: 'Oluşturulma', value: formatDateTime(purchase.createdAt) },
  ];

  return (
    <main className="purchase-detail-page">
      <DetailHeader
        back={{ href: '/package-purchases', label: 'Paket satışları' }}
        badges={
          <>
            <span className={statusBadgeClass(purchase.status)} data-testid="purchase-status">
              {statusLabel(purchase.status)}
            </span>
            {hold ? (
              <span className={holdOpen ? 'badge badge-warn' : 'badge badge-muted'}>
                {PURCHASE_CREDIT_HOLD_LABELS[hold.status]}
              </span>
            ) : null}
            {purchase.manualReviewAt ? <span className="badge badge-bad">Manuel inceleme</span> : null}
          </>
        }
        meta={
          <>
            <code>{purchaseRef}</code> · {formatDateTime(purchase.createdAt)}
          </>
        }
        title={purchase.packageNameSnapshot}
        subtitle={purchase.provider.businessName}
        actions={
          canOpenProvider || canOpenCredits ? (
            <>
              {canOpenProvider ? (
                <Link className="btn btn-secondary btn-sm" href={`/providers/${purchase.providerId}`}>
                  Hizmet vereni aç
                </Link>
              ) : null}
              {canOpenCredits ? (
                <Link className="btn btn-secondary btn-sm" href={`/providers/${purchase.providerId}/credits`}>
                  Kredi geçmişi
                </Link>
              ) : null}
            </>
          ) : undefined
        }
        facts={facts}
        factsLabel="Satın alma özeti"
        testId="purchase-header"
      />

      <div className="detail-panel detail-panel-grid">
        {hold ? (
          /*
           * API-HARDENING-001. The money and the credit disagree: the
           * provider's order was captured, the credit was not delivered
           * because it would pass the ledger bound. This card is where an
           * operator reads the gap and how it can close — nothing here
           * refunds or loads anything.
           */
          <section className="is-wide" data-testid="purchase-credit-hold-card">
            <SectionCard
              title="Tahsilat · kredi teslimi"
              actions={
                <span className={holdOpen ? 'badge badge-warn' : 'badge badge-muted'}>
                  {PURCHASE_CREDIT_HOLD_LABELS[hold.status]}
                </span>
              }
            >
              <KeyValueList
                items={[
                  {
                    label: 'Tahsil edilen',
                    value: <strong>{formatPrice(hold.chargedAmountMinor, hold.currency)}</strong>,
                    testId: 'purchase-credit-hold-charged',
                  },
                  {
                    label: 'Teslim edilecek kredi',
                    value: formatCount(hold.creditAmount),
                    testId: 'purchase-credit-hold-to-deliver',
                  },
                  {
                    label: 'Teslim edilen kredi',
                    value: hold.status === 'SETTLED' ? formatCount(hold.creditAmount) : '0',
                    testId: 'purchase-credit-hold-delivered',
                  },
                  { label: 'Sağlayıcı sipariş no', value: <code className="cell-break">{hold.providerOrderId ?? '—'}</code> },
                  {
                    label: 'Vaka açıldığında bakiye',
                    value: `${hold.balanceAtOpen !== undefined ? formatCount(hold.balanceAtOpen) : '—'} (üst sınır ${formatCount(CREDIT_AMOUNT_MAX)})`,
                  },
                  {
                    label: 'Reddedilen teslimat',
                    value: `${hold.refusedDeliveries ?? '—'}${hold.lastRefusedAt ? ` · son ${formatDateTime(hold.lastRefusedAt)}` : ''}`,
                  },
                  { label: 'Açıldı', value: formatDateTime(hold.openedAt) },
                  {
                    label: 'Kapandı',
                    value: hold.resolvedAt
                      ? `${formatDateTime(hold.resolvedAt)}${hold.resolvedEvent ? ` · ${hold.resolvedEvent.eventName}` : ''}`
                      : 'hayır',
                  },
                ]}
              />
              {holdOpen ? (
                <div className="notice-warning hold-steps" data-testid="purchase-credit-hold-steps">
                  <strong>Otomatik iade yapılmaz.</strong> İki çözüm yolu var ve karar yetkili personelindir:
                  <ol>
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
            </SectionCard>
          </section>
        ) : null}

        <SectionCard title="Özet">
          <KeyValueList
            items={[
              {
                label: 'Satın alma no',
                value: (
                  <>
                    <code>{purchaseRef}</code>
                    {purchase.purchaseNumber ? (
                      <details className="technical-id">
                        <summary>Teknik ID</summary>
                        <code>{purchase.id}</code>
                      </details>
                    ) : null}
                  </>
                ),
              },
              { label: 'Hizmet veren', value: purchase.provider.businessName },
              { label: 'HV e-posta', value: purchase.provider.email ?? '—' },
              { label: 'Paket', value: purchase.packageNameSnapshot },
              { label: 'Kredi', value: formatCount(purchase.creditAmountSnapshot) },
              { label: 'Tutar', value: <strong>{price}</strong> },
            ]}
          />
        </SectionCard>

        <SectionCard title="Zaman çizgisi">
          <KeyValueList
            items={[
              { label: 'Oluşturulma', value: formatDateTime(purchase.createdAt) },
              { label: 'Ödendi', value: purchase.paidAt ? formatDateTime(purchase.paidAt) : '—' },
              { label: 'Başarısız', value: purchase.failedAt ? formatDateTime(purchase.failedAt) : '—' },
              { label: 'İptal', value: purchase.cancelledAt ? formatDateTime(purchase.cancelledAt) : '—' },
              { label: 'Süre dolumu', value: purchase.expiredAt ? formatDateTime(purchase.expiredAt) : '—' },
            ]}
          />
        </SectionCard>

        <SectionCard title="Notlar ve referanslar">
          <KeyValueList
            items={[
              {
                label: 'Ödeme sağlayıcı',
                value: (
                  <>
                    <code>{purchase.paymentProvider ?? 'mock'}</code> <span className="badge badge-warn">test</span>
                  </>
                ),
              },
              { label: 'Ödeme referansı', value: purchase.mockPaymentReference ?? '—' },
              /*
                Opaque provider-side identifiers only. The correlation token this
                application mints is deliberately not shown anywhere: it is the
                value a webhook has to match, so it stays out of screens, logs
                and API responses that are not the purchase's own.
              */
              { label: 'Sağlayıcı sipariş no', value: purchase.providerOrderId ?? '—' },
              { label: 'Sağlayıcı ödeme oturumu', value: purchase.providerCheckoutId ?? '—' },
              {
                label: 'Başarısızlık sebebi',
                value: purchase.mockPaymentFailureReason ?? purchase.paymentFailureCode ?? '—',
              },
              {
                label: 'Manuel inceleme',
                value: purchase.manualReviewAt
                  ? `${purchase.manualReviewReason ?? 'Gerekli'} · ${formatDateTime(purchase.manualReviewAt)} — sağlayıcıdan iade/ters ibraz bildirimi geldi. Otomatik kredi düşülmedi.`
                  : '—',
              },
              { label: 'Kredi işlemi', value: purchase.creditTransactionId ?? '—' },
              { label: 'HV notu', value: purchase.providerNote ?? '—' },
              { label: 'Yönetici notu', value: purchase.adminNote ?? '—' },
            ]}
          />
        </SectionCard>

        {/*
          The settlement notices themselves. A refusal and the redelivery that
          later settled it are one event, so an operator otherwise sees only
          the end state and cannot tell a purchase that recovered from one that
          never stumbled.
        */}
        <SectionCard title="Sağlayıcı bildirimleri" subtitle="Ödeme sağlayıcısından gelen, imzası doğrulanmış bildirimler.">
          {purchase.webhookEvents?.length ? (
            <ol className="webhook-attempts" data-testid="purchase-webhook-events">
              {purchase.webhookEvents.map((attempt, index) => (
                <li key={`${attempt.eventName}-${index}`} className="webhook-attempt">
                  <p className="webhook-attempt-head">
                    <code>{attempt.eventName}</code> · {attempt.status}
                    {attempt.detail ? ` (${attempt.detail})` : ''} ·{' '}
                    {attempt.attemptCount === 1 ? '1 teslimat' : `${attempt.attemptCount} teslimat`}
                  </p>
                  <KeyValueList
                    items={[
                      {
                        label: 'İlk hata',
                        value: attempt.firstFailureCode
                          ? `${attempt.firstFailureCode}${attempt.firstFailureAt ? ` · ${formatDateTime(attempt.firstFailureAt)}` : ''}`
                          : '—',
                      },
                      { label: 'Son deneme', value: formatDateTime(attempt.lastAttemptAt) },
                      { label: 'Çözüldü', value: attempt.resolvedAt ? formatDateTime(attempt.resolvedAt) : 'hayır' },
                    ]}
                  />
                  {/*
                    API-HARDENING-001: a genuine, matching order refused
                    because its credits would pass the ledger's integer
                    bound. Nothing was written; the next delivery is judged
                    again.
                  */}
                  {attempt.status === 'MISMATCHED' && attempt.detail === 'CREDIT_BALANCE_LIMIT_EXCEEDED' ? (
                    <div className="notice-warning" data-testid="webhook-credit-limit-note">
                      Ödeme doğrulandı ama kredileri bakiyenin üst sınırını ({formatCount(CREDIT_AMOUNT_MAX)}) aşacağı
                      için yüklenmedi. Kısmi kredi yazılmadı, satın alma “Bekliyor” durumunda kaldı ve “Tahsilat ·
                      kredi teslimi” vakası açıldı; çözüm yolları o kartta.
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="detail-muted-note">Bu satın alma için sağlayıcı bildirimi yok.</p>
          )}
        </SectionCard>

        <div className="is-wide">
          {holdOpen ? (
            <div className="notice" data-testid="purchase-credit-hold-no-manual-fix">
              Bu satın almanın ödemesi tahsil edildi; iptal veya “Süresi doldu” olarak işaretlenemez. Vaka, kredi
              teslimi ya da bildirilen iade ile kapanır.
            </div>
          ) : purchase.status === 'PENDING' && !canFixStatus ? null : purchase.status === 'PENDING' ? (
            <SectionCard
              title="Manuel düzeltme"
              subtitle="Yalnız bekleyen bir satın alma için. Yönetici düzeltmesi sadece İptal veya Süresi doldu'yu destekler ve kredi kazandırmaz."
            >
              <form action={updatePackagePurchaseStatusAction} className="detail-form" data-testid="purchase-status-form">
                <input type="hidden" name="purchaseId" value={purchase.id} />
                <label className="detail-form-field" htmlFor="purchase-admin-note">
                  <span>Yönetici notu (isteğe bağlı, kayda geçer; hizmet verene gönderilmez)</span>
                  <textarea id="purchase-admin-note" name="adminNote" rows={3} />
                </label>
                <div className="detail-form-actions">
                  <ConfirmDialog
                    triggerLabel="İptal olarak işaretle"
                    triggerClassName="btn btn-destructive"
                    name="status"
                    value="CANCELLED"
                    title="Satın alma iptal edilsin mi?"
                    consequence={<PurchaseStatusConsequence status="CANCELLED" kind={purchase.kind} />}
                    confirmLabel="Evet, iptal olarak işaretle"
                    testId="purchase-mark-cancelled"
                  />
                  <ConfirmDialog
                    triggerLabel="Süresi doldu olarak işaretle"
                    triggerClassName="btn btn-secondary"
                    name="status"
                    value="EXPIRED"
                    title="Satın alma “Süresi doldu” olsun mu?"
                    consequence={<PurchaseStatusConsequence status="EXPIRED" kind={purchase.kind} />}
                    confirmLabel="Evet, süresi doldu olarak işaretle"
                    testId="purchase-mark-expired"
                  />
                </div>
              </form>
            </SectionCard>
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

import Link from 'next/link';
import {
  AdminPaymentConfig,
  apiFetch,
  PackagePurchase,
  PackagePurchaseStatus,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../lib/api';

type AdminPackagePurchasesPageProps = {
  searchParams?: Promise<{
    status?: PackagePurchaseStatus;
    providerId?: string;
    packageId?: string;
  }>;
};

export default async function AdminPackagePurchasesPage({ searchParams }: AdminPackagePurchasesPageProps) {
  const params = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.providerId) query.set('providerId', params.providerId);
  if (params.packageId) query.set('packageId', params.packageId);
  const [purchases, paymentConfig] = await Promise.all([
    apiFetch<PackagePurchase[]>(
      `/package-purchases${query.toString() ? `?${query.toString()}` : ''}`,
    ),
    apiFetch<AdminPaymentConfig>('/payments/config'),
  ]);

  const manualReviewCount = purchases.filter((purchase) => purchase.manualReviewAt).length;

  return (
    <main>
      <header className="page-header">
        <h1 className="page-title">Paket Talepleri</h1>
        <p className="page-subtitle">Hizmet verenlerin paket satın alma kayıtları.</p>
      </header>

      <section className="card" data-testid="payment-provider-config">
        <h2>Ödeme sağlayıcı</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Bu kurulum yalnızca <strong>test</strong> modunda çalışır ve gerçek tahsilat yapmaz. Canlı
          ödeme bu sürümde açılamaz: Lemon Squeezy&apos;nin bu pazar yeri için uygunluk onayı yazılı
          olarak alınmadan canlı moda geçilmeyecektir. Canlı moda işaret eden bir ortam değişkeni
          ayarlanırsa API açılışta durur.
        </p>
        <dl className="meta-row">
          <dt>Sağlayıcı</dt>
          <dd>
            <code>{paymentConfig.provider}</code>{' '}
            {paymentConfig.provider === 'lemon-squeezy-test'
              ? '(Lemon Squeezy sandbox)'
              : '(uygulama içi mock ödeme)'}
          </dd>
          <dt>Mod</dt>
          <dd>
            <span className="badge badge-warn">test</span>
          </dd>
          <dt>Canlı tahsilat</dt>
          <dd>Kapalı — bu sürümde açılamaz</dd>
          <dt>Yapılandırma</dt>
          <dd>
            {paymentConfig.ready ? (
              'Tamamlandı'
            ) : (
              <>
                Eksik ayar var:{' '}
                {paymentConfig.missingConfig.map((key) => (
                  <code key={key} style={{ marginRight: 6 }}>
                    {key}
                  </code>
                ))}
                <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  Yalnızca değişken adları gösterilir; API anahtarı ve webhook gizli anahtarı hiçbir
                  ekranda ve hiçbir API yanıtında görünmez.
                </span>
              </>
            )}
          </dd>
          <dt>Kredi yükleme</dt>
          <dd>
            Yalnızca imzası doğrulanmış ödeme bildirimi (webhook) sonrasında. Ödeme sayfasından
            dönüş, tarayıcı sonucu veya istemci isteği kredi yükleyemez.
          </dd>
        </dl>
      </section>

      {manualReviewCount > 0 ? (
        <div className="notice notice-warn" style={{ marginBottom: 18 }} data-testid="manual-review-notice">
          <strong>{manualReviewCount}</strong> satın alma için sağlayıcıdan iade/ters ibraz bildirimi
          geldi ve manuel inceleme bekliyor. Bu bildirimler otomatik olarak kredi düşmez.
        </div>
      ) : null}

      {query.toString() ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          Filtre aktif. <Link href="/package-purchases">Filtreleri temizle</Link>
        </div>
      ) : null}

      <div className="table-card">
        <div className="table-header">
          <h2>Paket talep listesi</h2>
          <span className="muted" style={{ fontSize: 13 }}>{purchases.length} kayıt</span>
        </div>
        {purchases.length === 0 ? (
          <div style={{ padding: 18 }} className="empty-state">Henüz paket talebi yok.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Satın Alma No</th>
                  <th>Oluşturulma</th>
                  <th>Hizmet Veren</th>
                  <th>Paket</th>
                  <th>Kredi</th>
                  <th>Tutar</th>
                  <th>Durum</th>
                  <th>Ödeme Referansı</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => {
                  const purchaseRef =
                    purchase.purchaseNumber ?? `#${purchase.id.slice(-8)}`;
                  return (
                  <tr key={purchase.id}>
                    <td>
                      <code className="display-number">{purchaseRef}</code>
                    </td>
                    <td>{formatDateTime(purchase.createdAt)}</td>
                    <td><strong>{purchase.provider.businessName}</strong></td>
                    <td>{purchase.packageNameSnapshot}</td>
                    <td>{purchase.creditAmountSnapshot}</td>
                    <td>{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</td>
                    <td>
                      <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{purchase.mockPaymentReference ?? '-'}</td>
                    <td>
                      <div className="inline-actions">
                        <Link className="btn btn-secondary btn-sm" href={`/package-purchases/${purchase.id}`}>
                          Detay
                        </Link>
                        <Link className="btn btn-ghost btn-sm" href={`/providers/${purchase.providerId}`}>
                          HV
                        </Link>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

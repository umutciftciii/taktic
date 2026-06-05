import Link from 'next/link';
import {
  apiFetch,
  PackagePurchase,
  statusLabel,
  statusBadgeClass,
  formatPrice,
  formatDateTime,
} from '../../../lib/api';
import { updatePackagePurchaseStatusAction } from '../actions';

type AdminPackagePurchaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminPackagePurchaseDetailPage({ params }: AdminPackagePurchaseDetailPageProps) {
  const { id } = await params;
  const purchase = await apiFetch<PackagePurchase>(`/package-purchases/${id}`);
  const purchaseRef = purchase.purchaseNumber ?? `#${purchase.id.slice(-8)}`;

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
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

      <div className="inline-actions" style={{ marginBottom: 18 }}>
        <Link className="btn btn-secondary btn-sm" href={`/providers/${purchase.providerId}`}>
          Hizmet vereni aç
        </Link>
        <Link className="btn btn-ghost btn-sm" href={`/providers/${purchase.providerId}/credits`}>
          Kredi geçmişi
        </Link>
      </div>

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
              <dt>Ödeme Referansı</dt>
              <dd>{purchase.mockPaymentReference ?? '-'}</dd>
              <dt>Başarısızlık sebebi</dt>
              <dd className="muted">{purchase.mockPaymentFailureReason ?? '-'}</dd>
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
          {purchase.status === 'PENDING' ? (
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

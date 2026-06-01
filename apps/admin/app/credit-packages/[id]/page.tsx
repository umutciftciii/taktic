import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  apiFetch,
  formatDateTime,
  formatMinorAsInput,
  formatPrice,
  OfferCreditPackage,
  PackagePurchase,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { EmptyState } from '../../../components/empty-state';
import {
  updateCreditPackageAction,
  updateCreditPackageStatusAction,
} from '../actions';

type CreditPackageDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
};

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

const OK_MESSAGES: Record<string, string> = {
  created: 'Paket oluşturuldu.',
  saved: 'Paket bilgileri kaydedildi.',
  activated: 'Paket aktifleştirildi.',
  deactivated: 'Paket pasifleştirildi.',
};

export default async function CreditPackageDetailPage({
  params,
  searchParams,
}: CreditPackageDetailPageProps) {
  await requireAdmin();
  const { id } = await params;
  const { error: rawError, ok: rawOk } = await searchParams;
  const errorMessage = (rawError ?? '').trim();
  const okKey = (rawOk ?? '').trim();
  const okMessage = okKey ? OK_MESSAGES[okKey] ?? null : null;

  const packages = await apiFetch<OfferCreditPackage[]>(
    '/credit-packages?includeInactive=true',
  );
  const creditPackage = packages.find((pkg) => pkg.id === id);
  if (!creditPackage) {
    notFound();
  }

  const selectedCurrency = (CURRENCIES as readonly string[]).includes(creditPackage.currency)
    ? creditPackage.currency
    : 'TRY';
  const currencyOptions = Array.from(new Set([...CURRENCIES, creditPackage.currency]));

  const purchases = await apiFetch<PackagePurchase[]>(
    `/package-purchases?packageId=${encodeURIComponent(id)}`,
  ).catch(() => [] as PackagePurchase[]);

  const sortedPurchases = [...purchases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const paidPurchases = sortedPurchases.filter((p) => p.status === 'PAID');
  const pendingPurchases = sortedPurchases.filter((p) => p.status === 'PENDING');
  const totalPaidCredits = paidPurchases.reduce((sum, p) => sum + p.creditAmountSnapshot, 0);
  const revenueByCurrency = paidPurchases.reduce<Record<string, number>>((acc, p) => {
    const cur = p.currencySnapshot || 'TRY';
    acc[cur] = (acc[cur] ?? 0) + p.priceAmountSnapshot;
    return acc;
  }, {});
  const revenueEntries = Object.entries(revenueByCurrency);
  const lastPurchase = sortedPurchases[0] ?? null;
  const lastPaid = paidPurchases[0] ?? null;
  const recentPurchases = sortedPurchases.slice(0, 5);

  return (
    <main className="credit-packages-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kredi Paketleri', href: '/credit-packages' },
          { label: creditPackage.name },
        ]}
        title={creditPackage.name}
        subtitle="Paket bilgilerini, durumunu ve satış özetini yönetin."
      />

      {errorMessage ? (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success" role="status" style={{ marginBottom: 12 }}>
          {okMessage}
        </div>
      ) : null}

      <div className="admin-meta-pills">
        <span
          className={
            creditPackage.isActive ? 'meta-pill meta-pill-good' : 'meta-pill meta-pill-muted'
          }
        >
          {creditPackage.isActive ? 'Aktif' : 'Pasif'}
        </span>
        <span className="meta-pill">
          slug <code>{creditPackage.slug}</code>
        </span>
        <span className="meta-pill">{creditPackage.creditAmount} kredi</span>
        <span className="meta-pill">
          {formatPrice(creditPackage.priceAmount, creditPackage.currency)}
        </span>
        <span className="meta-pill">sıra {creditPackage.sortOrder}</span>
        <span className="meta-pill">güncellenme {formatDateTime(creditPackage.updatedAt)}</span>
      </div>

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Paket bilgileri"
            subtitle="Provider satın alma akışında görünen alanlar. Değişiklikler mevcut satın almaları etkilemez (snapshot)."
          >
            <form action={updateCreditPackageAction} className="compact-form">
              <input type="hidden" name="id" value={creditPackage.id} />
              <div className="compact-field-grid">
                <label className="field field-8">
                  <span>İsim *</span>
                  <input
                    name="name"
                    required
                    defaultValue={creditPackage.name}
                    maxLength={120}
                  />
                </label>
                <label className="field field-4">
                  <span>Sıralama</span>
                  <input
                    name="sortOrder"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={creditPackage.sortOrder}
                  />
                  <span className="help-text">Küçük değer üstte görünür.</span>
                </label>

                <label className="field field-6">
                  <span>Slug *</span>
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    defaultValue={creditPackage.slug}
                  />
                  <span className="help-text">
                    Slug değiştirilirse harici bağlantılar kırılabilir. Provider satın alma akışı paketi id ile bulur, etkilenmez.
                  </span>
                </label>
                <label className="field field-3">
                  <span>Kredi *</span>
                  <input
                    name="creditAmount"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={creditPackage.creditAmount}
                  />
                </label>
                <label className="field field-3">
                  <span>Para birimi *</span>
                  <select name="currency" defaultValue={selectedCurrency} required>
                    {currencyOptions.map((cur) => (
                      <option key={cur} value={cur}>
                        {cur}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field field-6">
                  <span>Fiyat *</span>
                  <input
                    name="priceAmount"
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    placeholder="Örn. 149.90"
                    required
                    defaultValue={formatMinorAsInput(creditPackage.priceAmount)}
                  />
                  <span className="help-text">
                    Ondalıklı tutar girebilirsiniz. Örn: 149.90 {selectedCurrency} veya 1500. Mevcut
                    değer paketten okunarak basılır; değiştirip kaydedebilirsiniz.
                  </span>
                </label>
                <label className="field field-6">
                  <span>Durum</span>
                  <select name="isActive" defaultValue={String(creditPackage.isActive)}>
                    <option value="true">Aktif (satışa açık)</option>
                    <option value="false">Pasif (satışa kapalı)</option>
                  </select>
                  <span className="help-text">
                    Pasif paketler yeni satın alıma kapanır; mevcut satın almalar etkilenmez.
                  </span>
                </label>

                <label className="field">
                  <span>Açıklama</span>
                  <textarea
                    name="description"
                    placeholder="Paketi tanıtacak kısa metin (opsiyonel)."
                    defaultValue={creditPackage.description ?? ''}
                    maxLength={500}
                  />
                </label>
              </div>

              <div className="compact-actions">
                <button className="btn btn-primary btn-sm" type="submit">
                  Değişiklikleri kaydet
                </button>
                <Link className="btn btn-secondary btn-sm" href="/credit-packages">
                  Listeye dön
                </Link>
              </div>
            </form>
          </SectionCard>

          <SectionCard
            title="Satış özeti"
            subtitle="Bu pakete bağlı satın alma kayıtlarından özet (snapshot değerleri)."
          >
            {sortedPurchases.length === 0 ? (
              <EmptyState
                title="Bu pakete bağlı satın alma yok."
                description="Provider akışında satın alma gerçekleştiğinde özet burada görünür."
              />
            ) : (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    gap: 12,
                    marginBottom: 16,
                  }}
                >
                  <SummaryStat
                    label="Toplam satın alma"
                    value={String(sortedPurchases.length)}
                    hint={`${paidPurchases.length} ödenmiş · ${pendingPurchases.length} bekleyen`}
                  />
                  <SummaryStat
                    label="Yüklenen kredi"
                    value={String(totalPaidCredits)}
                    hint="Yalnızca ödenmiş paketler"
                  />
                  <SummaryStat
                    label="Toplam ciro"
                    value={
                      revenueEntries.length === 0
                        ? formatPrice(0, creditPackage.currency)
                        : revenueEntries.length === 1
                          ? formatPrice(revenueEntries[0]![1], revenueEntries[0]![0])
                          : 'Çoklu para birimi'
                    }
                    hint={
                      revenueEntries.length > 1
                        ? revenueEntries
                            .map(([cur, amount]) => formatPrice(amount, cur))
                            .join(' · ')
                        : 'Snapshot fiyat toplamı'
                    }
                  />
                  <SummaryStat
                    label="Son satın alma"
                    value={lastPurchase ? formatDateTime(lastPurchase.createdAt) : '-'}
                    hint={
                      lastPaid
                        ? `Son ödeme: ${formatDateTime(lastPaid.paidAt ?? lastPaid.createdAt)}`
                        : 'Ödenmiş satın alma yok'
                    }
                  />
                </div>

                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Hizmet veren</th>
                        <th>Durum</th>
                        <th className="col-num">Tutar</th>
                        <th>Referans</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentPurchases.map((purchase) => (
                        <tr key={purchase.id}>
                          <td>{formatDateTime(purchase.createdAt)}</td>
                          <td>
                            <Link
                              className="cell-link"
                              href={`/providers/${purchase.provider.id}`}
                            >
                              {purchase.provider.businessName}
                            </Link>
                          </td>
                          <td>
                            <span className={statusBadgeClass(purchase.status)}>
                              {statusLabel(purchase.status)}
                            </span>
                          </td>
                          <td className="col-num">
                            {formatPrice(
                              purchase.priceAmountSnapshot,
                              purchase.currencySnapshot,
                            )}
                          </td>
                          <td className="cell-muted" style={{ fontSize: 12 }}>
                            {purchase.mockPaymentReference ?? '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {sortedPurchases.length > recentPurchases.length ? (
                  <div style={{ padding: '12px 0 0', textAlign: 'right' }}>
                    <Link
                      className="btn btn-ghost btn-sm"
                      href={`/package-purchases?packageId=${encodeURIComponent(creditPackage.id)}`}
                    >
                      Tüm satın almaları gör ({sortedPurchases.length})
                    </Link>
                  </div>
                ) : null}
              </>
            )}
          </SectionCard>
        </div>

        <aside className="admin-side-column">
          <div className="admin-action-panel">
            <h3>Durum</h3>
            <p>
              {creditPackage.isActive
                ? 'Paket şu anda satışa açık. Pasifleştirildiğinde yeni satın almalar engellenir.'
                : 'Paket pasif. Yeni satın alımlar engellenmiş durumda; aktifleştirebilirsiniz.'}
            </p>
            <form action={updateCreditPackageStatusAction}>
              <input type="hidden" name="id" value={creditPackage.id} />
              <input
                type="hidden"
                name="isActive"
                value={String(!creditPackage.isActive)}
              />
              <input
                type="hidden"
                name="redirectTo"
                value={`/credit-packages/${creditPackage.id}`}
              />
              <button
                className={
                  creditPackage.isActive
                    ? 'btn btn-danger btn-sm btn-block'
                    : 'btn btn-primary btn-sm btn-block'
                }
                type="submit"
              >
                {creditPackage.isActive ? 'Paketi pasifleştir' : 'Paketi aktifleştir'}
              </button>
            </form>
          </div>

          <div className="helper-card">
            <h4>Hatırlatmalar</h4>
            <ul>
              <li>Fiyat ondalıklı girilir (örn. 149.90); kaydederken sistem otomatik olarak normalize eder.</li>
              <li>
                Satın alma kayıtları paketin o anki adı, kredisi, fiyatı ve para biriminin
                kopyasını tutar; sonraki değişiklikler eski kayıtları bozmaz.
              </li>
              <li>Slug değişikliği harici linkleri kırabilir.</li>
              <li>Pasifleştirme yıkıcı değildir; istediğiniz zaman geri açabilirsiniz.</li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'grid',
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{value}</span>
      {hint ? (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>
      ) : null}
    </div>
  );
}

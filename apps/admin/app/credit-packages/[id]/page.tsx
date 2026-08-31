import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  apiFetch,
  formatDateTime,
  formatMinorAsInput,
  formatPrice,
  AdminOfferPackage,
  PackagePurchase,
  UnlimitedEligibleCategory,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';

const PACKAGE_TYPE_LABEL: Record<string, string> = {
  ONE_TIME_CREDITS: 'Tek seferlik kredi',
  MONTHLY_QUOTA: 'Aylık kota (30 gün)',
  CATEGORY_UNLIMITED: 'Kategori limitsiz (30 gün)',
};
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

  // Read through the admin listing, which carries every type and each
  // package's category scope. The public route returns only one-time packages.
  const [creditPackage, eligibleCategories] = await Promise.all([
    apiFetch<AdminOfferPackage>(`/admin/offer-packages/${id}`).catch(() => null),
    apiFetch<UnlimitedEligibleCategory[]>('/admin/offer-packages/unlimited-eligible-categories'),
  ]);

  if (!creditPackage) {
    notFound();
  }

  const scopeIds = creditPackage.scopeCategories.map((scope) => scope.category.id);
  // A category that is in the scope but no longer eligible must still be
  // rendered, or saving the form would silently drop it.
  const scopeOptions = [
    ...eligibleCategories,
    ...creditPackage.scopeCategories
      .filter((scope) => !eligibleCategories.some((item) => item.id === scope.category.id))
      .map((scope) => ({ ...scope.category, parentId: null })),
  ];

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
        <span className="meta-pill">{PACKAGE_TYPE_LABEL[creditPackage.type] ?? creditPackage.type}</span>
        <span className="meta-pill">
          {creditPackage.type === 'MONTHLY_QUOTA'
            ? `${creditPackage.quotaCredits ?? 0} kredi kota`
            : creditPackage.type === 'CATEGORY_UNLIMITED'
              ? 'limitsiz'
              : `${creditPackage.creditAmount} kredi`}
        </span>
        {creditPackage.periodDays ? (
          <span className="meta-pill">{creditPackage.periodDays} gün geçerli</span>
        ) : null}
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
                {/*
                  * The type is not editable and is therefore not a form field:
                  * changing what a package sells would leave every period
                  * already bought against it describing a product that no
                  * longer exists. The API refuses it too.
                  */}
                <input type="hidden" name="type" value={creditPackage.type} />

                {creditPackage.type === 'ONE_TIME_CREDITS' ? (
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
                ) : null}

                {creditPackage.type === 'MONTHLY_QUOTA' ? (
                  <label className="field field-3">
                    <span>Aylık kota (kredi) *</span>
                    <input
                      name="quotaCredits"
                      type="number"
                      min="1"
                      step="1"
                      required
                      defaultValue={creditPackage.quotaCredits ?? 1}
                    />
                    <span className="help-text">
                      Kullanılmayan kota dönem sonunda devretmez.
                    </span>
                  </label>
                ) : null}

                {creditPackage.type === 'CATEGORY_UNLIMITED' ? (
                  <>
                    <label className="field field-3">
                      <span>Günlük teklif limiti</span>
                      <input
                        name="dailyOfferLimit"
                        type="number"
                        min="0"
                        step="1"
                        defaultValue={creditPackage.dailyOfferLimit ?? 0}
                      />
                      <span className="help-text">0 = günlük sınır yok.</span>
                    </label>
                    <label className="field field-12">
                      <span>Kapsam *</span>
                      <select
                        name="scopeCategoryIds"
                        multiple
                        size={Math.min(8, Math.max(2, scopeOptions.length))}
                        defaultValue={scopeIds}
                      >
                        {scopeOptions.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                            {category.kind === 'GROUP' ? ' (grup)' : ''}
                            {category.status === 'DRAFT' ? ' — taslak' : ''}
                          </option>
                        ))}
                      </select>
                      <span className="help-text">
                        Kapsamı değiştirmek yalnızca bundan sonraki satın almaları etkiler.
                        Satılmış paketlerin kapsamı satın alma anında dondurulmuştur.
                      </span>
                    </label>
                  </>
                ) : null}
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

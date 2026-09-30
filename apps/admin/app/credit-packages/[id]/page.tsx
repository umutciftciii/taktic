import { formatMinorAsTurkishLiraInput } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  formatPrice,
  AdminOfferPackage,
  PackagePurchase,
  UnlimitedEligibleCategory,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import { SummaryStrip, type SummaryItem } from '../../../components/summary-strip';
import { updateCreditPackageAction, updateCreditPackageStatusAction } from '../actions';
import { PackageStatusForm, packageAllowance, packageTypeLabel } from '../credit-package-cells';

/**
 * One credit package (#43). The design has no screen for it (`soon`); it is
 * built on the detail template (ADMIN-DESIGN-001 Faz 3F): a way back to the
 * list, the summary card (status, slug and order, name, and a strip with what
 * the package sells, for how long and at what price), then the edit form and
 * the sales summary beside the status desk.
 *
 * Unchanged: the form's fields and the payload it posts (the type rides along
 * as a hidden field and is never editable; `statusLocked` without
 * CREDIT_PACKAGES_STATUS), the read-only view without CREDIT_PACKAGES_WRITE,
 * the sales summary behind PACKAGE_PURCHASES_READ (F9) with the provider
 * link behind PROVIDERS_READ_DETAIL, and the status desk behind
 * CREDIT_PACKAGES_STATUS.
 */

const PURCHASE_COLUMNS: DataColumn[] = [
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'status', label: 'Durum' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'reference', label: 'Referans' },
];

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
  const { can } = await requireAdmin('CREDIT_PACKAGES_READ');
  const canWrite = can('CREDIT_PACKAGES_WRITE');
  const canChangeStatus = can('CREDIT_PACKAGES_STATUS');
  // The sales summary is a second read with its own permission.
  const canReadPurchases = can('PACKAGE_PURCHASES_READ');
  const canOpenProvider = can('PROVIDERS_READ_DETAIL');
  const { id } = await params;
  const { error: rawError, ok: rawOk } = await searchParams;
  const errorMessage = (rawError ?? '').trim();
  const okKey = (rawOk ?? '').trim();
  const okMessage = okKey ? OK_MESSAGES[okKey] ?? null : null;

  // Read through the admin listing, which carries every type and each
  // package's category scope. The public route returns only one-time packages.
  // A 404/400 is a missing package; a 401/403 stays the redirect apiFetch made it.
  const [creditPackage, eligibleCategories] = await Promise.all([
    fetchOrNotFound(() => apiFetch<AdminOfferPackage>(`/admin/offer-packages/${id}`)),
    apiFetch<UnlimitedEligibleCategory[]>('/admin/offer-packages/unlimited-eligible-categories'),
  ]);

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

  const purchases = canReadPurchases
    ? await apiFetch<PackagePurchase[]>(`/package-purchases?packageId=${encodeURIComponent(id)}`)
    : [];

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

  const facts: SummaryItem[] = [
    {
      label: 'Tür',
      value: packageTypeLabel(creditPackage.type),
      note: creditPackage.periodDays ? `${creditPackage.periodDays} gün geçerli` : 'süresiz',
      testId: 'credit-package-fact-type',
    },
    {
      label: creditPackage.type === 'MONTHLY_QUOTA' ? 'Aylık kota' : 'Kredi',
      value:
        creditPackage.type === 'MONTHLY_QUOTA'
          ? `${creditPackage.quotaCredits ?? 0} kredi`
          : creditPackage.type === 'CATEGORY_UNLIMITED'
            ? 'Limitsiz'
            : `${packageAllowance(creditPackage)} kredi`,
      note:
        creditPackage.type === 'CATEGORY_UNLIMITED'
          ? creditPackage.dailyOfferLimit
            ? `günlük en fazla ${creditPackage.dailyOfferLimit} teklif`
            : 'günlük sınır yok'
          : undefined,
      testId: 'credit-package-fact-allowance',
    },
    {
      label: 'Fiyat',
      value: formatPrice(creditPackage.priceAmount, creditPackage.currency),
      testId: 'credit-package-fact-price',
    },
    { label: 'Sıra', value: creditPackage.sortOrder },
    { label: 'Güncellenme', value: formatDateTime(creditPackage.updatedAt) },
  ];

  return (
    <main className="catalog-page catalog-detail-page">
      <DetailHeader
        back={{ href: '/credit-packages', label: 'Kredi paketleri' }}
        badges={
          <span
            className={creditPackage.isActive ? 'badge badge-good' : 'badge badge-muted'}
            data-testid="credit-package-status"
          >
            {creditPackage.isActive ? 'Aktif' : 'Pasif'}
          </span>
        }
        meta={<code className="cell-break">{creditPackage.slug}</code>}
        title={creditPackage.name}
        subtitle={
          creditPackage.type === 'CATEGORY_UNLIMITED'
            ? creditPackage.scopeCategories.length > 0
              ? `Kapsam: ${creditPackage.scopeCategories.map((scope) => scope.category.name).join(', ')}`
              : 'Kapsam tanımsız'
            : undefined
        }
        facts={facts}
        factsLabel="Paket özeti"
        testId="credit-package-header"
      />

      {errorMessage ? (
        <div className="notice notice-error detail-notice" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="notice notice-success detail-notice" role="status">
          {okMessage}
        </div>
      ) : null}

      <div className="admin-module-layout catalog-detail-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Paket bilgileri"
            subtitle="Hizmet verenin satın alma akışında görünen alanlar. Değişiklikler mevcut satın almaları etkilemez; her satın alma kendi kopyasını taşır."
          >
            {canWrite ? (
            <form action={updateCreditPackageAction} className="compact-form compact-form-wide">
              <input type="hidden" name="id" value={creditPackage.id} />
              <div className="compact-field-grid">
                <label className="field field-8">
                  <span>Paket adı *</span>
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
                  <span>Kısa ad (slug) *</span>
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    defaultValue={creditPackage.slug}
                  />
                  <span className="help-text">
                    Kısa ad değiştirilirse harici bağlantılar kırılabilir. Hizmet verenin satın alma akışı paketi kimliğiyle bulur, etkilenmez.
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
                    type="text"
                    inputMode="decimal"
                    pattern="([0-9]{1,3}(\.[0-9]{3})*|[0-9]+)(,[0-9]{1,2})?"
                    placeholder="Örn. 149,90"
                    required
                    defaultValue={formatMinorAsTurkishLiraInput(creditPackage.priceAmount)}
                  />
                  <span className="help-text">
                    Kuruş için virgül kullanın. Örn: 149,90 {selectedCurrency} veya 1.500. Mevcut
                    değer paketten okunarak basılır; değiştirip kaydedebilirsiniz.
                  </span>
                </label>
                <label className="field field-6">
                  <span>Durum</span>
                  {/*
                    The status is its own permission (CREDIT_PACKAGES_STATUS).
                    Without it the select is shown but cannot be moved, and the
                    save does not send `isActive` at all (`statusLocked`), so a
                    stale page cannot turn an ordinary edit into a 403.
                  */}
                  {canChangeStatus ? null : (
                    <input type="hidden" name="statusLocked" value="1" />
                  )}
                  <select
                    name={canChangeStatus ? 'isActive' : undefined}
                    defaultValue={String(creditPackage.isActive)}
                    disabled={!canChangeStatus}
                  >
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
            ) : (
              <div className="catalog-readonly" data-testid="credit-package-read-only">
                <KeyValueList
                  items={[
                    { label: 'Paket adı', value: creditPackage.name },
                    { label: 'Kısa ad', value: <code className="cell-break">{creditPackage.slug}</code> },
                    ...(creditPackage.type === 'CATEGORY_UNLIMITED'
                      ? [
                          {
                            label: 'Günlük teklif limiti',
                            value: creditPackage.dailyOfferLimit ? creditPackage.dailyOfferLimit : 'Sınır yok',
                          },
                          {
                            label: 'Kapsam',
                            value:
                              creditPackage.scopeCategories.length > 0
                                ? creditPackage.scopeCategories.map((scope) => scope.category.name).join(', ')
                                : 'Kapsam tanımsız',
                          },
                        ]
                      : []),
                    { label: 'Para birimi', value: creditPackage.currency },
                    { label: 'Açıklama', value: creditPackage.description ?? '—' },
                  ]}
                />
              </div>
            )}
          </SectionCard>

          {canReadPurchases ? (
            <SectionCard
              title="Satış özeti"
              subtitle="Bu pakete bağlı satın alma kayıtlarından özet (satın alma anındaki değerler)."
              testId="credit-package-sales"
            >
              {sortedPurchases.length === 0 ? (
                <EmptyState
                  title="Bu pakete bağlı satın alma yok."
                  description="Hizmet veren bu paketi satın aldığında özet burada görünür."
                />
              ) : (
                <div className="catalog-sales">
                  <SummaryStrip
                    label="Satış özeti"
                    items={[
                      {
                        label: 'Toplam satın alma',
                        value: formatCount(sortedPurchases.length),
                        note: `${paidPurchases.length} ödenmiş · ${pendingPurchases.length} bekleyen`,
                      },
                      {
                        label: 'Yüklenen kredi',
                        value: formatCount(totalPaidCredits),
                        note: 'Yalnızca ödenmiş paketler',
                      },
                      {
                        label: 'Toplam ciro',
                        value:
                          revenueEntries.length === 0
                            ? formatPrice(0, creditPackage.currency)
                            : revenueEntries.length === 1
                              ? formatPrice(revenueEntries[0]![1], revenueEntries[0]![0])
                              : 'Çoklu para birimi',
                        note:
                          revenueEntries.length > 1
                            ? revenueEntries.map(([cur, amount]) => formatPrice(amount, cur)).join(' · ')
                            : 'Satın alma anındaki fiyatların toplamı',
                      },
                      {
                        label: 'Son satın alma',
                        value: lastPurchase ? formatDateTime(lastPurchase.createdAt) : '-',
                        note: lastPaid
                          ? `Son ödeme: ${formatDateTime(lastPaid.paidAt ?? lastPaid.createdAt)}`
                          : 'Ödenmiş satın alma yok',
                      },
                    ]}
                  />

                  <DataTable caption="Son satın almalar" columns={PURCHASE_COLUMNS} minWidth={720}>
                    {recentPurchases.map((purchase) => (
                      <tr key={purchase.id}>
                        <td className="cell-nowrap">{formatDateTime(purchase.createdAt)}</td>
                        <td>
                          {canOpenProvider ? (
                            <Link className="cell-link cell-break" href={`/providers/${purchase.provider.id}`}>
                              {purchase.provider.businessName}
                            </Link>
                          ) : (
                            <span className="cell-break">{purchase.provider.businessName}</span>
                          )}
                        </td>
                        <td>
                          <span className={statusBadgeClass(purchase.status)}>{statusLabel(purchase.status)}</span>
                        </td>
                        <td className="is-num">
                          {formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}
                        </td>
                        <td className="cell-muted cell-break">{purchase.mockPaymentReference ?? '-'}</td>
                      </tr>
                    ))}
                  </DataTable>

                  {sortedPurchases.length > recentPurchases.length ? (
                    <div className="catalog-sales-more">
                      <Link
                        className="btn btn-secondary btn-sm"
                        href={`/package-purchases?packageId=${encodeURIComponent(creditPackage.id)}`}
                      >
                        Tüm satın almaları gör ({sortedPurchases.length})
                      </Link>
                    </div>
                  ) : null}
                </div>
              )}
            </SectionCard>
          ) : null}
        </div>

        <aside className="admin-side-column" aria-label="Paket işlemleri">
          {canChangeStatus ? (
            <SectionCard title="Durum" className="catalog-side-card" testId="credit-package-status-panel">
              <div className="catalog-side-body">
                <p>
                  {creditPackage.isActive
                    ? 'Paket şu anda satışa açık. Pasifleştirildiğinde yeni satın almalar engellenir.'
                    : 'Paket pasif. Yeni satın alımlar engellenmiş durumda; aktifleştirebilirsiniz.'}
                </p>
                <PackageStatusForm
                  pkg={creditPackage}
                  redirectTo={`/credit-packages/${creditPackage.id}`}
                  action={updateCreditPackageStatusAction}
                  variant="panel"
                />
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="Hatırlatmalar" className="catalog-side-card">
            <ul className="catalog-side-list">
              <li>Fiyat lira olarak, kuruş için virgülle girilir (örn. 149,90); sistem kaydederken kuruşa çevirir.</li>
              <li>
                Satın alma kayıtları paketin o anki adı, kredisi, fiyatı ve para biriminin kopyasını tutar; sonraki
                değişiklikler eski kayıtları bozmaz.
              </li>
              <li>Kısa ad değişikliği harici bağlantıları kırabilir.</li>
              <li>Pasifleştirme yıkıcı değildir; istediğiniz zaman geri açabilirsiniz.</li>
            </ul>
          </SectionCard>
        </aside>
      </div>
    </main>
  );
}

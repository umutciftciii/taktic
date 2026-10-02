import { formatMinorAsTurkishLiraInput } from '@taktic/shared';
import Link from 'next/link';
import {
  apiFetch,
  fetchOrNotFound,
  formatDateTime,
  getCreditPackageHistory,
  formatPrice,
  AdminOfferPackage,
  PackagePurchase,
  UnlimitedEligibleCategory,
  requireAdmin,
  statusBadgeClass,
  statusLabel,
} from '../../../lib/api';
import { formatCount } from '../../../lib/pagination';
import { parsePage, resolveTab } from '../../../lib/list-query';
import { AUDIT_SINCE_NOTE, AuditTimeline } from '../../../components/audit-timeline';
import { DataTable, type DataColumn } from '../../../components/data-table';
import { DetailFormFooter, LockedField } from '../../../components/detail-form-footer';
import { DetailHeader } from '../../../components/detail-header';
import { EmptyState } from '../../../components/empty-state';
import { KeyValueList } from '../../../components/key-value-list';
import { SectionCard } from '../../../components/section-card';
import { SummaryStrip, type SummaryItem } from '../../../components/summary-strip';
import { Tabs, type TabItem } from '../../../components/tabs';
import { updateCreditPackageAction, updateCreditPackageStatusAction } from '../actions';
import { CreditPackageEditSubmit } from '../credit-package-gates';
import { creditPackageTerms } from '../package-changes';
import {
  PACKAGE_TYPE_DESCRIPTION,
  PACKAGE_TYPE_LABEL,
  PackageStatusForm,
  packageAllowance,
  packageSummarySentence,
  packageTypeLabel,
  perCreditMinor,
} from '../credit-package-cells';

/**
 * One credit package (#43), on the design's tabbed detail screen
 * (ADMIN-DESIGN-001 Faz 3F.1): a way back to the list, the summary card
 * (status and type, slug and order, name, what the package does, and a strip
 * with what it sells, at what price), the record's actions — the purchases
 * list and Pasifleştir/Aktifleştir — then three tabs as links (`?tab=`):
 *
 * - Paket bilgileri (the plain URL): the edit form, and what the other types
 *   would have been.
 * - Satışlar (PACKAGE_PURCHASES_READ, F9): the sales summary and the latest
 *   purchases, with the provider link behind PROVIDERS_READ_DETAIL.
 * - Neler oldu: the package's change log (ADMIN-ACTION-AUDIT-001) — each
 *   create, edit and status switch with its field diff and its operator.
 *
 * Unchanged: the form's fields and the payload it posts (the type rides along
 * as a hidden field and is never editable; `statusLocked` without
 * CREDIT_PACKAGES_STATUS), the read-only view without CREDIT_PACKAGES_WRITE,
 * the sales figures, and the status switch behind CREDIT_PACKAGES_STATUS —
 * now in the summary card rather than a side panel. Every save and switch
 * redirects to the plain URL, which is the tab it was made on.
 */

const PURCHASE_COLUMNS: DataColumn[] = [
  { key: 'date', label: 'Tarih' },
  { key: 'provider', label: 'Hizmet veren' },
  { key: 'status', label: 'Durum' },
  { key: 'amount', label: 'Tutar', align: 'end' },
  { key: 'number', label: 'Satın alma no' },
  { key: 'reference', label: 'Ödeme referansı' },
];

type CreditPackageDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string; tab?: string; gecmisSayfa?: string }>;
};

type TabKey = '' | 'satislar' | 'gecmis';

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

const RECENT_PURCHASES = 5;

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
  const { error: rawError, ok: rawOk, tab, gecmisSayfa } = await searchParams;
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
  const recentPurchases = sortedPurchases.slice(0, RECENT_PURCHASES);
  const purchasesHref = `/package-purchases?packageId=${encodeURIComponent(creditPackage.id)}`;

  const unitPrice = perCreditMinor(creditPackage);
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
          : unitPrice !== null
            ? `kredi başı ${formatPrice(unitPrice, creditPackage.currency)}`
            : undefined,
      testId: 'credit-package-fact-allowance',
    },
    {
      label: 'Fiyat',
      value: formatPrice(creditPackage.priceAmount, creditPackage.currency),
      note: creditPackage.currency,
      testId: 'credit-package-fact-price',
    },
    { label: 'Sıra', value: creditPackage.sortOrder, note: 'listeleme sırası' },
    { label: 'Güncellenme', value: formatDateTime(creditPackage.updatedAt) },
  ];

  const path = `/credit-packages/${creditPackage.id}`;
  const tabs: TabItem[] = [
    { key: '', label: 'Paket bilgileri', testId: 'credit-package-tab-bilgiler' },
    ...(canReadPurchases
      ? [{ key: 'satislar', label: 'Satışlar', count: sortedPurchases.length, testId: 'credit-package-tab-satislar' }]
      : []),
    { key: 'gecmis', label: 'Neler oldu', testId: 'credit-package-tab-gecmis' },
  ];
  const activeTab = resolveTab<TabKey>(
    tab,
    tabs.map((item) => item.key as TabKey),
    '',
  );
  const historyPage = parsePage(gecmisSayfa);
  const history = activeTab === 'gecmis' ? await getCreditPackageHistory(creditPackage.id, historyPage) : null;

  return (
    <main className="catalog-page catalog-detail-page">
      <DetailHeader
        back={{ href: '/credit-packages', label: 'Kredi paketleri' }}
        badges={
          <>
            <span
              className={creditPackage.isActive ? 'badge badge-good' : 'badge badge-muted'}
              data-testid="credit-package-status"
            >
              {creditPackage.isActive ? 'Aktif' : 'Pasif'}
            </span>
            <span className="badge badge-muted">{packageTypeLabel(creditPackage.type)}</span>
          </>
        }
        meta={
          <>
            <code className="cell-break">{creditPackage.slug}</code> · sıra {creditPackage.sortOrder}
          </>
        }
        title={creditPackage.name}
        subtitle={packageSummarySentence(creditPackage)}
        actions={
          canReadPurchases || canChangeStatus ? (
            <>
              {canReadPurchases ? (
                <Link className="btn btn-secondary" href={purchasesHref}>
                  Tüm satın almaları gör
                </Link>
              ) : null}
              {/*
                The old side panel's switch, where the design puts it. Both
                directions ask first (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
              */}
              {canChangeStatus ? (
                <span data-testid="credit-package-status-panel">
                  <PackageStatusForm
                    pkg={creditPackage}
                    redirectTo={path}
                    action={updateCreditPackageStatusAction}
                    variant="panel"
                  />
                </span>
              ) : null}
            </>
          ) : undefined
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

      <Tabs label="Paket sekmeleri" items={tabs} active={activeTab} path={path} testId="credit-package-tabs" />

      {activeTab === '' ? (
        <div className="detail-tab-panel" data-testid="credit-package-panel-bilgiler">
          <SectionCard
            title="Paket bilgileri"
            actions={<span className="section-card-meta">Hizmet verenin satın alma ekranında görünen alanlar</span>}
            className="detail-tab-card"
          >
            {canWrite ? (
              <form action={updateCreditPackageAction} className="compact-form compact-form-wide">
                <input type="hidden" name="id" value={creditPackage.id} />
                <div className="compact-field-grid">
                  <label className="field field-4">
                    <span>Paket adı *</span>
                    <input name="name" required defaultValue={creditPackage.name} maxLength={120} />
                  </label>
                  <label className="field field-4">
                    <span>Kısa ad (slug) *</span>
                    <input
                      name="slug"
                      required
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      defaultValue={creditPackage.slug}
                    />
                    <span className="help-text">
                      Değiştirilirse dış bağlantılar kırılabilir. Satın alma akışı paketi kimliğiyle bulur,
                      etkilenmez.
                    </span>
                  </label>
                  {/*
                    The type is not editable and is therefore not a form field:
                    changing what a package sells would leave every period
                    already bought against it describing a product that no
                    longer exists. The API refuses it too.
                  */}
                  <LockedField
                    label="Tür"
                    value={packageTypeLabel(creditPackage.type)}
                    help="Tür sonradan değiştirilemez; satılmış paketler başka bir ürünü anlatır hâle gelirdi."
                    testId="credit-package-type-locked"
                  />
                  <input type="hidden" name="type" value={creditPackage.type} />

                  {creditPackage.type === 'ONE_TIME_CREDITS' ? (
                    <label className="field field-4">
                      <span>Kredi *</span>
                      <input
                        name="creditAmount"
                        type="number"
                        min="1"
                        step="1"
                        required
                        defaultValue={creditPackage.creditAmount}
                      />
                      <span className="help-text">Satın alındığında hesaba bir kez yüklenir.</span>
                    </label>
                  ) : null}

                  {creditPackage.type === 'MONTHLY_QUOTA' ? (
                    <label className="field field-4">
                      <span>Aylık kota (kredi) *</span>
                      <input
                        name="quotaCredits"
                        type="number"
                        min="1"
                        step="1"
                        required
                        defaultValue={creditPackage.quotaCredits ?? 1}
                      />
                      <span className="help-text">Kullanılmayan kota dönem sonunda devretmez.</span>
                    </label>
                  ) : null}

                  {creditPackage.type === 'CATEGORY_UNLIMITED' ? (
                    <label className="field field-4">
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
                  ) : null}

                  <label className="field field-4">
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
                      Kuruş için virgül kullanın. Örn: 149,90 {selectedCurrency} veya 1.500. Sistem kuruşa çevirerek
                      saklar.
                    </span>
                  </label>
                  <label className="field field-4">
                    <span>Para birimi *</span>
                    <select name="currency" defaultValue={selectedCurrency} required>
                      {currencyOptions.map((cur) => (
                        <option key={cur} value={cur}>
                          {cur}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field field-4">
                    <span>Durum</span>
                    {/*
                      The status is its own permission (CREDIT_PACKAGES_STATUS).
                      Without it the select is shown but cannot be moved, and the
                      save does not send `isActive` at all (`statusLocked`), so a
                      stale page cannot turn an ordinary edit into a 403.
                    */}
                    {canChangeStatus ? null : <input type="hidden" name="statusLocked" value="1" />}
                    <select
                      name={canChangeStatus ? 'isActive' : undefined}
                      defaultValue={String(creditPackage.isActive)}
                      disabled={!canChangeStatus}
                    >
                      <option value="true">Aktif (satışa açık)</option>
                      <option value="false">Pasif (satışa kapalı)</option>
                    </select>
                    <span className="help-text">
                      Pasif paket yeni satışa kapanır; satılmışlar ve yüklenmiş krediler etkilenmez. İstediğiniz zaman
                      geri açabilirsiniz. Durum değişikliği kaydederken onay ister.
                    </span>
                  </label>
                  <label className="field field-4">
                    <span>Sıralama</span>
                    <input name="sortOrder" type="number" min="0" step="1" defaultValue={creditPackage.sortOrder} />
                    <span className="help-text">Küçük değer hizmet verene önce listelenir.</span>
                  </label>

                  {creditPackage.type === 'CATEGORY_UNLIMITED' ? (
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
                        Kapsamı değiştirmek yalnızca bundan sonraki satın almaları etkiler. Satılmış paketlerin kapsamı
                        satın alma anında dondurulmuştur.
                      </span>
                    </label>
                  ) : null}

                  <label className="field field-12">
                    <span>Açıklama</span>
                    <textarea
                      name="description"
                      placeholder="Paketi tanıtacak kısa metin (opsiyonel)."
                      defaultValue={creditPackage.description ?? ''}
                      maxLength={500}
                    />
                    <span className="help-text">Paketi tanıtan kısa metin. En fazla 500 karakter.</span>
                  </label>
                </div>

                <DetailFormFooter note="Değişiklikler satılmış paketleri etkilemez; her satın alma paketin o anki adını, kredisini ve fiyatını saklar.">
                  {/*
                    Asks only when the save changes the price, the credits, the
                    scope or the status (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A).
                  */}
                  <CreditPackageEditSubmit
                    stored={{
                      name: creditPackage.name,
                      isActive: creditPackage.isActive,
                      ...creditPackageTerms(creditPackage),
                    }}
                    statusEditable={canChangeStatus}
                    categoryNames={Object.fromEntries(scopeOptions.map((category) => [category.id, category.name]))}
                  />
                </DetailFormFooter>
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

          <SectionCard title="Paketin diğer türleri" padded={false} className="detail-tab-card">
            <ul className="detail-fact-cards" data-testid="credit-package-types">
              {(Object.keys(PACKAGE_TYPE_LABEL) as Array<keyof typeof PACKAGE_TYPE_LABEL>).map((type) => (
                <li key={type} className={type === creditPackage.type ? 'is-current' : undefined}>
                  <h3>{PACKAGE_TYPE_LABEL[type]}</h3>
                  <p>
                    {PACKAGE_TYPE_DESCRIPTION[type]}
                    {type === creditPackage.type ? ' Bu paket bu türde.' : ''}
                  </p>
                </li>
              ))}
              <li>
                <h3>Tür seçimi</h3>
                <p>Tür yalnız paket oluşturulurken seçilir. Farklı türde bir paket için yeni paket oluşturulur.</p>
              </li>
            </ul>
          </SectionCard>
        </div>
      ) : null}

      {activeTab === 'satislar' && canReadPurchases ? (
        <div className="detail-tab-panel" data-testid="credit-package-panel-satislar">
          <SectionCard
            title="Satış özeti"
            actions={<span className="section-card-meta">Satın alma anındaki değerlerle</span>}
            padded={false}
            className="detail-tab-card"
            testId="credit-package-sales"
          >
            {sortedPurchases.length === 0 ? (
              <EmptyState
                title="Bu pakete bağlı satın alma yok."
                description="Hizmet veren bu paketi satın aldığında özet burada görünür."
              />
            ) : (
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
            )}
          </SectionCard>

          {sortedPurchases.length > 0 ? (
            <SectionCard
              title="Son satın almalar"
              actions={
                <span className="section-card-meta">
                  {formatCount(sortedPurchases.length)} satın almadan son {recentPurchases.length} kayıt
                </span>
              }
              padded={false}
              className="detail-tab-card"
              testId="credit-package-recent-purchases"
            >
              <DataTable caption="Son satın almalar" columns={PURCHASE_COLUMNS} minWidth={760}>
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
                    <td className="is-num">{formatPrice(purchase.priceAmountSnapshot, purchase.currencySnapshot)}</td>
                    <td>
                      <Link className="cell-link cell-nowrap" href={`/package-purchases/${purchase.id}`}>
                        {purchase.purchaseNumber ?? 'Aç'}
                      </Link>
                    </td>
                    <td className="cell-muted cell-break">{purchase.mockPaymentReference ?? '-'}</td>
                  </tr>
                ))}
              </DataTable>
              <div className="detail-card-footer">
                <p>Tüm satın almalar Finans › Paket satışları ekranında bu pakete göre filtrelenmiş açılır.</p>
                <div className="detail-card-footer-actions">
                  <Link className="btn btn-secondary btn-sm" href={purchasesHref}>
                    Tüm satın almaları gör ({sortedPurchases.length})
                  </Link>
                </div>
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'gecmis' && history ? (
        <div className="detail-tab-panel" data-testid="credit-package-panel-gecmis">
          <AuditTimeline
            page={history}
            meta={`Paket ${formatDateTime(creditPackage.createdAt)} tarihinde oluşturuldu`}
            empty="Kayıt tutulmaya başladığından beri bu pakette değişiklik yapılmadı."
            footnote={AUDIT_SINCE_NOTE}
            testId="credit-package-activity"
            pager={{ path: `/credit-packages/${creditPackage.id}`, params: { tab: 'gecmis' }, pageParam: 'gecmisSayfa' }}
          />
        </div>
      ) : null}
    </main>
  );
}

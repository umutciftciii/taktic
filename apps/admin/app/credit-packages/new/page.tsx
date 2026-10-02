import Link from 'next/link';
import { apiFetch, requireAdmin, type UnlimitedEligibleCategory } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { createCreditPackageAction } from '../actions';
import { CreditPackageCreateSubmit } from '../credit-package-gates';

type NewCreditPackagePageProps = {
  searchParams: Promise<{
    error?: string;
    name?: string;
    slug?: string;
    type?: string;
    creditAmount?: string;
    quotaCredits?: string;
    dailyOfferLimit?: string;
    scopeCategoryIds?: string | string[];
    priceAmount?: string;
    currency?: string;
    description?: string;
    sortOrder?: string;
    isActive?: string;
  }>;
};

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

const PACKAGE_TYPES = [
  { value: 'ONE_TIME_CREDITS', label: 'Tek seferlik kredi (süresiz)' },
  { value: 'MONTHLY_QUOTA', label: 'Aylık kota (30 gün)' },
  { value: 'CATEGORY_UNLIMITED', label: 'Kategori limitsiz (30 gün)' },
] as const;

/**
 * A new credit package (#42). The design has no screen for it (`soon`), so it
 * is built on the form template (ADMIN-DESIGN-001 Faz 3F): a way back to the
 * list, the title with its ⓘ — which now carries what the side cards said —
 * and the form, whose twelve fields, names, type rules and action are
 * unchanged.
 */
export default async function NewCreditPackagePage({ searchParams }: NewCreditPackagePageProps) {
  // WRITE for the form, READ for the eligible-category list it is built from
  // (`GET /admin/offer-packages/unlimited-eligible-categories`).
  const { can } = await requireAdmin('CREDIT_PACKAGES_READ', 'CREDIT_PACKAGES_WRITE');
  // An active package is on sale the moment it exists, so the API asks for
  // CREDIT_PACKAGES_STATUS as well to create one (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
  // Without it the form offers the inactive package only.
  const canChooseStatus = can('CREDIT_PACKAGES_STATUS');
  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  // The pool an unlimited scope may be drawn from. Empty until an admin marks
  // categories eligible in category management, which is what keeps regulated
  // and high-value categories out of unlimited packages by default.
  const eligibleCategories = await apiFetch<UnlimitedEligibleCategory[]>(
    '/admin/offer-packages/unlimited-eligible-categories',
  );

  const selectedScope = new Set(
    Array.isArray(params.scopeCategoryIds)
      ? params.scopeCategoryIds
      : params.scopeCategoryIds
        ? [params.scopeCategoryIds]
        : [],
  );

  const draft = {
    name: params.name ?? '',
    slug: params.slug ?? '',
    type: params.type ?? 'ONE_TIME_CREDITS',
    creditAmount: params.creditAmount ?? '',
    quotaCredits: params.quotaCredits ?? '',
    dailyOfferLimit: params.dailyOfferLimit ?? '',
    priceAmount: params.priceAmount ?? '',
    currency: (params.currency ?? 'TRY').toUpperCase(),
    description: params.description ?? '',
    sortOrder: params.sortOrder ?? '0',
    isActive: canChooseStatus && params.isActive !== 'false',
  };
  const selectedCurrency = (CURRENCIES as readonly string[]).includes(draft.currency)
    ? draft.currency
    : 'TRY';

  return (
    <main className="catalog-page catalog-form-page">
      <Link className="detail-back" href="/credit-packages">
        <span aria-hidden="true">‹</span> Kredi paketleri
      </Link>
      <PageHeader
        title="Yeni kredi paketi"
        subtitle="Hizmet verenler için yeni bir paket tanımlayın. Tür kaydedildikten sonra değiştirilemez."
        infoLabel="Paket nasıl oluşturulur?"
        info={
          <span className="popover-list">
            <span>Kısa ad (slug) benzersizdir; aynı kısa adla ikinci paket oluşturulamaz.</span>
            <span>Fiyat lira olarak, kuruş için virgülle girilir; örn. 149,90 veya 1.500.</span>
            <span>Sıralama değeri küçük olan üstte görünür; eşit değerlerde isme göre alfabetik sıralanır.</span>
            <span>Pasif paketler hizmet veren akışında listelenmez ancak silinmez.</span>
            <span>Paket oluşturulduktan sonra detay ekranında satış özetini ve durumunu yönetebilirsiniz.</span>
          </span>
        }
      />

      {errorMessage ? (
        <div className="notice notice-error detail-notice" role="alert">
          {errorMessage}
        </div>
      ) : null}

      <div className="catalog-stack">
        <SectionCard
          title="Paket bilgileri"
          subtitle="Listede ve hizmet verenin satın alma akışında görünecek alanlar."
        >
          <form action={createCreditPackageAction} className="compact-form">
            <div className="compact-field-grid">
              <label className="field field-8">
                <span>Paket adı *</span>
                <input
                  name="name"
                  required
                  defaultValue={draft.name}
                  autoFocus
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
                  defaultValue={draft.sortOrder}
                />
                <span className="help-text">Küçük değer üstte görünür.</span>
              </label>

              <label className="field field-6">
                <span>Kısa ad (slug) *</span>
                <input
                  name="slug"
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  placeholder="ornek-paket"
                  defaultValue={draft.slug}
                />
                <span className="help-text">Yalnızca küçük harf, rakam ve tire (-).</span>
              </label>
              <label className="field field-3">
                <span>Paket türü *</span>
                <select name="type" defaultValue={draft.type} required>
                  {PACKAGE_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="help-text">
                  Tür sonradan değiştirilemez. Dönemsel paketler satın alma anından itibaren
                  tam 30 gün sürer; takvim ayı kullanılmaz.
                </span>
              </label>
              <label className="field field-3">
                <span>Kredi (tek seferlik paket)</span>
                <input
                  name="creditAmount"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={draft.creditAmount || '1'}
                />
                <span className="help-text">
                  Yalnızca tek seferlik kredi paketlerinde kullanılır.
                </span>
              </label>
              <label className="field field-3">
                <span>Aylık kota (kredi)</span>
                <input
                  name="quotaCredits"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={draft.quotaCredits}
                />
                <span className="help-text">
                  Yalnızca aylık kota paketlerinde. Kullanılmayan kota dönem sonunda devretmez.
                </span>
              </label>
              <label className="field field-3">
                <span>Günlük teklif limiti</span>
                <input
                  name="dailyOfferLimit"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={draft.dailyOfferLimit || '0'}
                />
                <span className="help-text">
                  Yalnızca limitsiz paketlerde. 0 = günlük sınır yok.
                </span>
              </label>
              <label className="field field-12">
                <span>Limitsiz paket kapsamı</span>
                {eligibleCategories.length === 0 ? (
                  <span className="help-text">
                    Limitsiz paket kapsamına açılmış kategori yok. Kategori yönetiminden
                    &ldquo;limitsiz paket uygunluğu&rdquo;nu açtığınız kategoriler burada
                    listelenir. Regüle veya yüksek değerli kategoriler varsayılan olarak
                    kapalıdır.
                  </span>
                ) : (
                  <>
                    <select
                      name="scopeCategoryIds"
                      multiple
                      size={Math.min(8, eligibleCategories.length)}
                      defaultValue={[...selectedScope]}
                    >
                      {eligibleCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                          {category.kind === 'GROUP' ? ' (grup)' : ''}
                          {category.status === 'DRAFT' ? ' — taslak' : ''}
                        </option>
                      ))}
                    </select>
                    <span className="help-text">
                      Yalnızca limitsiz paketlerde kullanılır. Bir grup seçtiğinizde satın alma
                      anındaki alt kategorileri de kapsanır ve bu kapsam o satın alma için
                      dondurulur.
                    </span>
                  </>
                )}
              </label>
              <label className="field field-3">
                <span>Para birimi *</span>
                <select name="currency" defaultValue={selectedCurrency} required>
                  {CURRENCIES.map((cur) => (
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
                  defaultValue={draft.priceAmount}
                />
                <span className="help-text">
                  Kuruş için virgül kullanın. Örn: 149,90 {selectedCurrency} veya 1.500.
                </span>
              </label>
              <label className="field field-6">
                <span>Durum</span>
                {canChooseStatus ? (
                  <select name="isActive" defaultValue={String(draft.isActive)} data-testid="credit-package-new-status">
                    <option value="true">Aktif (satışa açık)</option>
                    <option value="false">Pasif (satışa kapalı)</option>
                  </select>
                ) : (
                  <>
                    {/*
                      No CREDIT_PACKAGES_STATUS: the package is created inactive,
                      and the shown select cannot be moved. A disabled select
                      never reaches FormData, so the value travels in the hidden
                      field; the API refuses an active create anyway.
                    */}
                    <input type="hidden" name="isActive" value="false" />
                    <select defaultValue="false" disabled data-testid="credit-package-new-status">
                      <option value="false">Pasif (satışa kapalı)</option>
                    </select>
                  </>
                )}
                <span className="help-text" data-testid="credit-package-new-status-help">
                  {canChooseStatus
                    ? 'Aktif paket oluşturulduğu anda satışa çıkar; oluştururken onay istenir. Pasif paketler yeni satın alıma kapanır, mevcut satın almaları etkilemez.'
                    : 'Paket pasif oluşturulur. Satışa açmak paket durumu yetkisi gerektirir; bu yetkiye sahip biri paketi detay ekranından aktifleştirebilir.'}
                </span>
              </label>

              <label className="field">
                <span>Açıklama</span>
                <textarea
                  name="description"
                  placeholder="Paketi tanıtacak kısa metin (opsiyonel)."
                  defaultValue={draft.description}
                  maxLength={500}
                />
              </label>
            </div>

            <div className="compact-actions">
              {/* An active package asks first: it is on sale the moment it exists. */}
              <CreditPackageCreateSubmit />
              <Link className="btn btn-secondary btn-sm" href="/credit-packages">
                Vazgeç
              </Link>
            </div>
          </form>
        </SectionCard>
      </div>
    </main>
  );
}

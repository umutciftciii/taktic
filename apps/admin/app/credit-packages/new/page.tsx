import Link from 'next/link';
import { apiFetch, requireAdmin, type UnlimitedEligibleCategory } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { createCreditPackageAction } from '../actions';

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

export default async function NewCreditPackagePage({ searchParams }: NewCreditPackagePageProps) {
  await requireAdmin();
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
    isActive: params.isActive !== 'false',
  };
  const selectedCurrency = (CURRENCIES as readonly string[]).includes(draft.currency)
    ? draft.currency
    : 'TRY';

  return (
    <main className="credit-packages-page">
      <PageHeader
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Kredi Paketleri', href: '/credit-packages' },
          { label: 'Yeni' },
        ]}
        title="Yeni Kredi Paketi"
        subtitle="Hizmet verenler için yeni bir kredi paketi tanımlayın."
      />

      {errorMessage ? (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
          {errorMessage}
        </div>
      ) : null}

      <div className="admin-module-layout">
        <div className="admin-main-column">
          <SectionCard
            title="Paket bilgileri"
            subtitle="Listede ve provider satın alma akışında görünecek alanlar."
          >
            <form action={createCreditPackageAction} className="compact-form">
              <div className="compact-field-grid">
                <label className="field field-8">
                  <span>İsim *</span>
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
                  <span>Slug *</span>
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
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    placeholder="Örn. 149.90"
                    required
                    defaultValue={draft.priceAmount}
                  />
                  <span className="help-text">
                    Ondalıklı tutar girebilirsiniz. Örn: 149.90 {selectedCurrency} veya 1500.
                  </span>
                </label>
                <label className="field field-6">
                  <span>Durum</span>
                  <select name="isActive" defaultValue={String(draft.isActive)}>
                    <option value="true">Aktif (satışa açık)</option>
                    <option value="false">Pasif (satışa kapalı)</option>
                  </select>
                  <span className="help-text">
                    Pasif paketler yeni satın alıma kapanır, mevcut satın almaları etkilemez.
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
                <button className="btn btn-primary btn-sm" type="submit">
                  Paketi oluştur
                </button>
                <Link className="btn btn-secondary btn-sm" href="/credit-packages">
                  Vazgeç
                </Link>
              </div>
            </form>
          </SectionCard>
        </div>

        <aside className="admin-side-column">
          <div className="helper-card">
            <h4>Hızlı ipuçları</h4>
            <p>Paket oluştururken aklınızda bulundurun:</p>
            <ul>
              <li>Slug benzersizdir; aynı slug ile ikinci paket oluşturulamaz.</li>
              <li>Fiyat alanına ondalıklı tutar girebilirsiniz; örn. 149.90 veya 1500.</li>
              <li>Sıralama değeri küçük olan üstte görünür; eşit değerlerde isme göre alfabetik sıralanır.</li>
              <li>Pasif paketler provider akışında listelenmez ancak silinmez.</li>
            </ul>
          </div>

          <div className="admin-action-panel">
            <h3>Sıradaki adım</h3>
            <p>
              Paket oluşturulduktan sonra detay sayfasında satış özetini ve durum değişikliklerini
              yönetebilirsiniz.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

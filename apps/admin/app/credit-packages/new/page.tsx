import Link from 'next/link';
import { requireAdmin } from '../../../lib/api';
import { PageHeader } from '../../../components/page-header';
import { SectionCard } from '../../../components/section-card';
import { createCreditPackageAction } from '../actions';

type NewCreditPackagePageProps = {
  searchParams: Promise<{
    error?: string;
    name?: string;
    slug?: string;
    creditAmount?: string;
    priceAmount?: string;
    currency?: string;
    description?: string;
    sortOrder?: string;
    isActive?: string;
  }>;
};

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

export default async function NewCreditPackagePage({ searchParams }: NewCreditPackagePageProps) {
  await requireAdmin();
  const params = await searchParams;
  const errorMessage = (params.error ?? '').trim();
  const draft = {
    name: params.name ?? '',
    slug: params.slug ?? '',
    creditAmount: params.creditAmount ?? '',
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
                  <span>Kredi *</span>
                  <input
                    name="creditAmount"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={draft.creditAmount || '1'}
                  />
                  <span className="help-text">Satın alımda yüklenecek kredi adedi.</span>
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

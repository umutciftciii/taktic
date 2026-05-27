import Link from 'next/link';
import { apiFetch, Category, ProviderProfile } from '../../../../lib/api';
import { updateProviderAction } from '../../actions';

type ProviderEditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderEditPage({ params }: ProviderEditPageProps) {
  const { id } = await params;
  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);
  const selectedCategoryIds = new Set(provider.serviceCategories.map((item) => item.category.id));
  const firstArea = provider.serviceAreas[0];

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${provider.id}`}>Profil</Link>
        <span aria-hidden="true">/</span>
        <span>Düzenle</span>
      </p>

      <header className="page-header page-narrow">
        <h1 className="page-title">Profil Düzenle</h1>
        <p className="page-subtitle">İşletme bilgilerinizi ve hizmet kapsamınızı güncelleyin.</p>
      </header>

      <form action={updateProviderAction} className="form-card">
        <input type="hidden" name="id" value={provider.id} />

        <section className="form-section">
          <h2>İşletme Bilgileri</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>İşletme adı *</span>
              <input name="businessName" required defaultValue={provider.businessName} />
            </label>
            <label className="form-row">
              <span>Yetkili kişi *</span>
              <input name="contactName" required defaultValue={provider.contactName} />
            </label>
          </div>
          <label className="form-row">
            <span>Açıklama</span>
            <textarea name="description" defaultValue={provider.description ?? ''} />
          </label>
        </section>

        <section className="form-section">
          <h2>İletişim</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>Telefon *</span>
              <input name="phone" required defaultValue={provider.phone} />
            </label>
            <label className="form-row">
              <span>E-posta</span>
              <input name="email" type="email" defaultValue={provider.email ?? ''} />
            </label>
          </div>
        </section>

        <section className="form-section">
          <h2>Adres</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>İl *</span>
              <input name="city" required defaultValue={provider.city} />
            </label>
            <label className="form-row">
              <span>İlçe *</span>
              <input name="district" required defaultValue={provider.district} />
            </label>
          </div>
          <label className="form-row">
            <span>Adres notu</span>
            <textarea name="addressNote" defaultValue={provider.addressNote ?? ''} />
          </label>
        </section>

        <section className="form-section">
          <h2>Kategoriler</h2>
          <div className="checkbox-group">
            {categories.map((category) => (
              <label className="checkbox-row" key={category.id}>
                <input
                  name="categoryIds"
                  type="checkbox"
                  value={category.id}
                  defaultChecked={selectedCategoryIds.has(category.id)}
                />
                <span>{category.name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="form-section">
          <h2>Hizmet Bölgesi</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>İl *</span>
              <input name="serviceAreaCity" required defaultValue={firstArea?.city ?? provider.city} />
            </label>
            <label className="form-row">
              <span>İlçe</span>
              <input name="serviceAreaDistrict" defaultValue={firstArea?.district ?? provider.district} />
            </label>
            <label className="form-row">
              <span>Mahalle</span>
              <input name="serviceAreaNeighborhood" defaultValue={firstArea?.neighborhood ?? ''} />
            </label>
          </div>
        </section>

        <div className="form-actions">
          <button className="btn btn-primary" type="submit">Profili Kaydet</button>
          <Link className="btn btn-secondary" href={`/providers/${provider.id}`}>Vazgeç</Link>
        </div>
      </form>
    </main>
  );
}

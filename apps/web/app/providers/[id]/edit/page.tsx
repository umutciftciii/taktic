import { redirect } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, Category, getCurrentUser, ProviderProfile } from '../../../../lib/api';
import { updateProviderAction } from '../../actions';
import { ProviderShell } from '../../provider-shell';

type ProviderEditPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProviderEditPage({ params }: ProviderEditPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?redirectTo=/providers/${id}/edit`);
  }

  const [provider, categories] = await Promise.all([
    apiFetch<ProviderProfile>(`/providers/${id}`),
    apiFetch<Category[]>('/categories'),
  ]);
  const selectedCategoryIds = new Set(provider.serviceCategories.map((item) => item.category.id));
  const firstArea = provider.serviceAreas[0];

  return (
    <ProviderShell user={user} providerId={provider.id} businessName={provider.businessName} active="profile">
      <p className="pdash-crumbs">
        <Link href="/providers/me">Panelim</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/providers/${provider.id}`}>Profil</Link>
        <span aria-hidden="true">/</span>
        <span>Düzenle</span>
      </p>

      <header className="pdash-page-head">
        <h1 className="pdash-page-title">Profil Düzenle</h1>
        <p className="pdash-page-sub">İşletme bilgilerinizi ve hizmet kapsamınızı güncelleyin.</p>
      </header>

      <form action={updateProviderAction} className="pdash-detail-card pdash-form">
        <input type="hidden" name="id" value={provider.id} />

        <section className="pdash-form-section">
          <h2>İşletme Bilgileri</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>İşletme adı *</span>
              <input name="businessName" required defaultValue={provider.businessName} />
            </label>
            <label className="pdash-form-row">
              <span>Yetkili kişi *</span>
              <input name="contactName" required defaultValue={provider.contactName} />
            </label>
          </div>
          <label className="pdash-form-row">
            <span>Açıklama</span>
            <textarea name="description" defaultValue={provider.description ?? ''} />
          </label>
        </section>

        <section className="pdash-form-section">
          <h2>İletişim</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>Telefon *</span>
              <input name="phone" required defaultValue={provider.phone} />
            </label>
            <label className="pdash-form-row">
              <span>E-posta</span>
              <input name="email" type="email" defaultValue={provider.email ?? ''} />
            </label>
          </div>
        </section>

        <section className="pdash-form-section">
          <h2>Merkez Adres</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>İl *</span>
              <input name="city" required defaultValue={provider.city} />
            </label>
            <label className="pdash-form-row">
              <span>İlçe *</span>
              <input name="district" required defaultValue={provider.district} />
            </label>
          </div>
          <label className="pdash-form-row">
            <span>Adres notu</span>
            <textarea name="addressNote" defaultValue={provider.addressNote ?? ''} />
          </label>
        </section>

        <section className="pdash-form-section">
          <h2>Hizmet Kategorileri</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 8,
            }}
          >
            {categories.map((category) => (
              <label
                key={category.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 13.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
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

        <section className="pdash-form-section">
          <h2>Hizmet Bölgesi</h2>
          <div className="pdash-form-grid">
            <label className="pdash-form-row">
              <span>İl *</span>
              <input name="serviceAreaCity" required defaultValue={firstArea?.city ?? provider.city} />
            </label>
            <label className="pdash-form-row">
              <span>İlçe</span>
              <input name="serviceAreaDistrict" defaultValue={firstArea?.district ?? provider.district} />
            </label>
            <label className="pdash-form-row">
              <span>Mahalle</span>
              <input name="serviceAreaNeighborhood" defaultValue={firstArea?.neighborhood ?? ''} />
            </label>
          </div>
        </section>

        <div className="pdash-form-foot">
          <Link className="pdash-btn pdash-btn-secondary" href={`/providers/${provider.id}`}>
            Vazgeç
          </Link>
          <button className="pdash-btn pdash-btn-primary" type="submit">
            Profili Kaydet
          </button>
        </div>
      </form>
    </ProviderShell>
  );
}

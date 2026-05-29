import Link from 'next/link';
import { apiFetch, Category, getCurrentUser } from '../../../lib/api';
import { createProviderAction } from '../actions';

export default async function ProviderRegisterPage() {
  const [categories, user] = await Promise.all([
    apiFetch<Category[]>('/categories'),
    getCurrentUser(),
  ]);

  return (
    <div className="provider-apply-shell">
      <div className="provider-apply-container">
        <nav className="provider-apply-breadcrumbs" aria-label="Breadcrumb">
          <Link href="/">Ana sayfa</Link>
          <span aria-hidden="true">/</span>
          <span>Hizmet Veren Başvurusu</span>
        </nav>

        <header className="provider-apply-header">
          <h1 className="provider-apply-title">Hizmet Veren Başvurusu</h1>
          <p className="provider-apply-subtitle">
            İşletme bilgilerinizi paylaşın, hizmet kategorilerinizi seçin. Onay sonrası teklif vermeye başlayabilirsiniz.
          </p>
        </header>

        {!user ? (
          <div className="provider-apply-notice" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">i</span>
            <span>
              Misafir başvuru hâlâ açık. Başvurunuzu hesabınıza bağlamak için önce{' '}
              <Link href="/register/provider">hizmet veren hesabı oluşturabilirsiniz</Link>.
            </span>
          </div>
        ) : null}
        {user?.role === 'PROVIDER' ? (
          <div className="provider-apply-notice" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">i</span>
            <span>Bu başvuru hizmet veren hesabınıza bağlanacak.</span>
          </div>
        ) : null}
        {user?.role === 'CUSTOMER' ? (
          <div className="provider-apply-notice is-warning" role="status">
            <span className="provider-apply-notice-icon" aria-hidden="true">!</span>
            <span>Müşteri hesabıyla hizmet veren profili oluşturulamaz.</span>
          </div>
        ) : null}

        <form action={createProviderAction} className="provider-apply-form">
          <section className="provider-apply-card">
            <div className="provider-apply-card-head">
              <h2 className="provider-apply-card-title">İşletme Bilgileri</h2>
              <p className="provider-apply-card-subtitle">İşletmenizi tanıtacak temel bilgiler.</p>
            </div>
            <div className="provider-apply-grid">
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  İşletme adı <span className="provider-apply-required">*</span>
                </span>
                <input
                  className="provider-apply-input"
                  name="businessName"
                  required
                  placeholder="Örn. Yıldız Klima"
                />
              </label>
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  Yetkili kişi <span className="provider-apply-required">*</span>
                </span>
                <input
                  className="provider-apply-input"
                  name="contactName"
                  required
                  placeholder="Ad Soyad"
                />
              </label>
              <label className="provider-apply-field provider-apply-field-full">
                <span className="provider-apply-label">Açıklama</span>
                <textarea
                  className="provider-apply-textarea"
                  name="description"
                  placeholder="Müşterilerinize işletmenizden kısaca bahsedin."
                />
              </label>
            </div>
          </section>

          <section className="provider-apply-card">
            <div className="provider-apply-card-head">
              <h2 className="provider-apply-card-title">İletişim</h2>
            </div>
            <div className="provider-apply-grid">
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  Telefon <span className="provider-apply-required">*</span>
                </span>
                <input
                  className="provider-apply-input"
                  name="phone"
                  required
                  placeholder="05XX XXX XX XX"
                />
              </label>
              <label className="provider-apply-field">
                <span className="provider-apply-label">E-posta</span>
                <input
                  className="provider-apply-input"
                  name="email"
                  type="email"
                  placeholder="ornek@firma.com"
                />
              </label>
            </div>
          </section>

          <section className="provider-apply-card">
            <div className="provider-apply-card-head">
              <h2 className="provider-apply-card-title">Adres</h2>
            </div>
            <div className="provider-apply-grid">
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  İl <span className="provider-apply-required">*</span>
                </span>
                <input className="provider-apply-input" name="city" required />
              </label>
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  İlçe <span className="provider-apply-required">*</span>
                </span>
                <input className="provider-apply-input" name="district" required />
              </label>
              <label className="provider-apply-field provider-apply-field-full">
                <span className="provider-apply-label">Adres notu</span>
                <textarea
                  className="provider-apply-textarea"
                  name="addressNote"
                  placeholder="Müşterilerin sizi bulması için ek bilgi"
                />
              </label>
            </div>
          </section>

          <section className="provider-apply-card">
            <div className="provider-apply-card-head">
              <h2 className="provider-apply-card-title">Hizmet Kategorileri</h2>
              <p className="provider-apply-card-subtitle">Teklif verebileceğiniz kategorileri seçin.</p>
            </div>
            <div className="provider-apply-categories">
              {categories.map((category) => (
                <label className="provider-apply-category" key={category.id}>
                  <input name="categoryIds" type="checkbox" value={category.id} />
                  <span>{category.name}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="provider-apply-card">
            <div className="provider-apply-card-head">
              <h2 className="provider-apply-card-title">Hizmet Bölgesi</h2>
              <p className="provider-apply-card-subtitle">
                İlk hizmet vermek istediğiniz bölgeyi belirtin. Onay sonrası genişletebilirsiniz.
              </p>
            </div>
            <div className="provider-apply-grid-3">
              <label className="provider-apply-field">
                <span className="provider-apply-label">
                  İl <span className="provider-apply-required">*</span>
                </span>
                <input className="provider-apply-input" name="serviceAreaCity" required />
              </label>
              <label className="provider-apply-field">
                <span className="provider-apply-label">İlçe</span>
                <input className="provider-apply-input" name="serviceAreaDistrict" />
              </label>
              <label className="provider-apply-field">
                <span className="provider-apply-label">Mahalle</span>
                <input className="provider-apply-input" name="serviceAreaNeighborhood" />
              </label>
            </div>
          </section>

          <div className="provider-apply-actions">
            <button className="provider-apply-submit" type="submit">
              Başvuruyu Gönder
            </button>
            <Link className="provider-apply-cancel" href="/">
              Vazgeç
            </Link>
            <span className="provider-apply-required-note">* zorunlu alanlar</span>
          </div>
        </form>
      </div>
    </div>
  );
}

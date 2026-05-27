import Link from 'next/link';
import { apiFetch, Category, getCurrentUser } from '../../../lib/api';
import { createProviderAction } from '../actions';

export default async function ProviderRegisterPage() {
  const [categories, user] = await Promise.all([
    apiFetch<Category[]>('/categories'),
    getCurrentUser(),
  ]);

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Ana sayfa</Link>
        <span aria-hidden="true">/</span>
        <span>Hizmet Veren Başvurusu</span>
      </p>

      <header className="page-header page-narrow">
        <h1 className="page-title">Hizmet Veren Başvurusu</h1>
        <p className="page-subtitle">
          İşletme bilgilerinizi paylaşın, hizmet kategorilerinizi seçin. Onay sonrası teklif vermeye başlayabilirsiniz.
        </p>
      </header>

      {!user ? (
        <div className="page-narrow" style={{ marginBottom: 18 }}>
          <div className="notice">
            Misafir başvuru hâlâ açık. Başvurunuzu hesabınıza bağlamak için önce{' '}
            <Link href="/register/provider">hizmet veren hesabı oluşturabilirsiniz</Link>.
          </div>
        </div>
      ) : null}
      {user?.role === 'PROVIDER' ? (
        <div className="page-narrow" style={{ marginBottom: 18 }}>
          <div className="notice">Bu başvuru hizmet veren hesabınıza bağlanacak.</div>
        </div>
      ) : null}
      {user?.role === 'CUSTOMER' ? (
        <div className="page-narrow" style={{ marginBottom: 18 }}>
          <div className="notice-warning">
            Müşteri hesabıyla hizmet veren profili oluşturulamaz.
          </div>
        </div>
      ) : null}

      <form action={createProviderAction} className="form-card">
        <section className="form-section">
          <h2>İşletme Bilgileri</h2>
          <p className="form-section-subtitle">İşletmenizi tanıtacak temel bilgiler.</p>
          <div className="form-grid">
            <label className="form-row">
              <span>İşletme adı *</span>
              <input name="businessName" required />
            </label>
            <label className="form-row">
              <span>Yetkili kişi *</span>
              <input name="contactName" required />
            </label>
          </div>
          <label className="form-row">
            <span>Açıklama</span>
            <textarea name="description" placeholder="Müşterilerinize işletmenizden kısaca bahsedin." />
          </label>
        </section>

        <section className="form-section">
          <h2>İletişim</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>Telefon *</span>
              <input name="phone" required placeholder="05XX XXX XX XX" />
            </label>
            <label className="form-row">
              <span>E-posta</span>
              <input name="email" type="email" placeholder="ornek@firma.com" />
            </label>
          </div>
        </section>

        <section className="form-section">
          <h2>Adres</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>İl *</span>
              <input name="city" required />
            </label>
            <label className="form-row">
              <span>İlçe *</span>
              <input name="district" required />
            </label>
          </div>
          <label className="form-row">
            <span>Adres notu</span>
            <textarea name="addressNote" placeholder="Müşterilerin sizi bulması için ek bilgi" />
          </label>
        </section>

        <section className="form-section">
          <h2>Hizmet Kategorileri</h2>
          <p className="form-section-subtitle">Teklif verebileceğiniz kategorileri seçin.</p>
          <div className="checkbox-group">
            {categories.map((category) => (
              <label className="checkbox-row" key={category.id}>
                <input name="categoryIds" type="checkbox" value={category.id} />
                <span>{category.name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="form-section">
          <h2>Hizmet Bölgesi</h2>
          <p className="form-section-subtitle">İlk hizmet vermek istediğiniz bölgeyi belirtin. Onay sonrası genişletebilirsiniz.</p>
          <div className="form-grid">
            <label className="form-row">
              <span>İl *</span>
              <input name="serviceAreaCity" required />
            </label>
            <label className="form-row">
              <span>İlçe</span>
              <input name="serviceAreaDistrict" />
            </label>
            <label className="form-row">
              <span>Mahalle</span>
              <input name="serviceAreaNeighborhood" />
            </label>
          </div>
        </section>

        <div className="form-actions page-narrow" style={{ borderTop: 0, paddingTop: 0 }}>
          <button className="btn btn-primary" type="submit">Başvuruyu Gönder</button>
          <Link className="btn btn-secondary" href="/">Vazgeç</Link>
          <span className="muted">* zorunlu alanlar</span>
        </div>
      </form>
    </main>
  );
}

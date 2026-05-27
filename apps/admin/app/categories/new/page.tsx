import Link from 'next/link';
import { createCategoryAction } from '../actions';
import { requireAdmin } from '../../../lib/api';

export default async function NewCategoryPage() {
  await requireAdmin();

  return (
    <main>
      <p className="breadcrumbs">
        <Link href="/">Dashboard</Link>
        <span aria-hidden="true">/</span>
        <Link href="/categories">Kategoriler</Link>
        <span aria-hidden="true">/</span>
        <span>Yeni</span>
      </p>

      <header className="page-header page-narrow">
        <h1 className="page-title">Yeni Kategori</h1>
        <p className="page-subtitle">Hizmet kategorisi oluşturun. Sorular daha sonra eklenecek.</p>
      </header>

      <form action={createCategoryAction} className="form-card">
        <section className="form-section">
          <h2>Kategori Bilgileri</h2>
          <div className="form-grid">
            <label className="form-row">
              <span>İsim *</span>
              <input name="name" required />
            </label>
            <label className="form-row">
              <span>Slug *</span>
              <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="ornek-kategori" />
            </label>
            <label className="form-row">
              <span>Sıralama</span>
              <input name="sortOrder" type="number" min="0" defaultValue="0" />
            </label>
          </div>
          <label className="form-row">
            <span>Açıklama</span>
            <textarea name="description" />
          </label>
        </section>

        <input type="hidden" name="isActive" value="true" />
        <div className="form-actions">
          <button className="btn btn-primary" type="submit">Oluştur</button>
          <Link className="btn btn-secondary" href="/categories">Vazgeç</Link>
        </div>
      </form>
    </main>
  );
}

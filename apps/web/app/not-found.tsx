import Link from 'next/link';

export default function NotFound() {
  return (
    <main>
      <div className="page-narrow">
        <section className="card" style={{ margin: 0, textAlign: 'center', padding: 32 }}>
          <span className="badge badge-muted" style={{ fontSize: 13, padding: '8px 14px' }}>404</span>
          <h1 className="page-title" style={{ marginTop: 14 }}>Sayfa bulunamadı</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Aradığınız kayıt kaldırılmış olabilir ya da bu bağlantıya erişim yetkiniz yok.
          </p>
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 18 }}>
            <Link className="btn btn-primary" href="/">Ana sayfa</Link>
            <Link className="btn btn-ghost" href="/categories">Kategoriler</Link>
          </div>
        </section>
      </div>
    </main>
  );
}

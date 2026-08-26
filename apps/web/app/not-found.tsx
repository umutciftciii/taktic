import Link from 'next/link';

export default function NotFound() {
  return (
    <main>
      <div className="page-narrow">
        <span className="kicker">404</span>
        <h1 className="page-title">Sayfa bulunamadı</h1>
        <p className="page-subtitle">
          Aradığınız kayıt kaldırılmış olabilir ya da bu bağlantıya erişim yetkiniz yok.
        </p>
        <div className="inline-actions" style={{ marginTop: 24 }}>
          <Link className="btn btn-primary" href="/">
            Ana sayfa
          </Link>
          <Link className="btn btn-secondary" href="/categories">
            Kategoriler
          </Link>
        </div>
      </div>
    </main>
  );
}

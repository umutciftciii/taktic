import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <span className="badge badge-info" style={{ marginBottom: 12 }}>Yerel hizmet pazaryeri</span>
        <h1>İhtiyacın olan hizmeti bul, güvenle aldır.</h1>
        <p className="muted" style={{ fontSize: 17, maxWidth: 640 }}>
          TakTic, yerel hizmet taleplerini doğru hizmet verenlerle buluşturur. Hizmet veren tarafında adil
          teklif kredisi ve iade modeli vardır.
        </p>
        <div className="inline-actions" style={{ marginTop: 18 }}>
          <Link className="btn btn-primary" href="/categories">Hizmet Al</Link>
          <Link className="btn btn-secondary" href="/providers/register">Hizmet Ver</Link>
          <Link className="btn btn-ghost" href="/login">Giriş yap</Link>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 20 }}>Hızlı erişim</h2>
        <div className="summary-grid">
          <Link className="summary-card" href="/categories">
            <span className="muted">Müşteri</span>
            <span className="metric">Talep oluştur</span>
            <span className="help-text">Kategori seç, sorulara yanıt ver, teklif bekle.</span>
          </Link>
          <Link className="summary-card" href="/requests/my">
            <span className="muted">Takip</span>
            <span className="metric">Taleplerim</span>
            <span className="help-text">Taleplerinin durumunu ve teklifleri buradan görüntüle.</span>
          </Link>
          <Link className="summary-card" href="/providers/me">
            <span className="muted">Hizmet Veren</span>
            <span className="metric">Panelim</span>
            <span className="help-text">Eşleşen talepler, tekliflerin ve kredi bakiyeni yönet.</span>
          </Link>
        </div>
      </section>
    </main>
  );
}

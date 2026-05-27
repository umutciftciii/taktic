import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <h1>TakTic</h1>
        <p className="muted">Yerel hizmet taleplerini doğru hizmet verenlerle buluşturan adil pazar yeri.</p>
        <p className="actions">
          <Link className="button" href="/categories">Hizmet Al</Link>
          <Link className="button button-secondary" href="/providers/register">Hizmet Ver</Link>
          <Link href="/login">Giriş yap</Link>
        </p>
      </section>
      <section className="summary-grid">
        <Link className="summary-card" href="/categories">
          <span className="muted">Müşteri</span>
          <span className="metric">Talep oluştur</span>
        </Link>
        <Link className="summary-card" href="/requests/my">
          <span className="muted">Takip</span>
          <span className="metric">Taleplerim</span>
        </Link>
        <Link className="summary-card" href="/providers/me">
          <span className="muted">Hizmet veren</span>
          <span className="metric">Panelim</span>
        </Link>
      </section>
    </main>
  );
}

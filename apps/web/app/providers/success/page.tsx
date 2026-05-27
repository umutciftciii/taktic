import Link from 'next/link';

type ProviderSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

export default async function ProviderSuccessPage({ searchParams }: ProviderSuccessPageProps) {
  const { id } = await searchParams;

  return (
    <main>
      <div className="page-narrow">
        <section className="card" style={{ margin: 0, textAlign: 'center', padding: 32 }}>
          <span className="badge badge-good" style={{ fontSize: 13, padding: '8px 14px' }}>Başvuru alındı</span>
          <h1 className="page-title" style={{ marginTop: 14 }}>Başvurunuz ön incelemeye gönderildi</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Onay sonrasında eşleşen taleplere teklif vermeye başlayabilirsiniz.
          </p>
          {id ? (
            <p style={{ marginTop: 14 }}>
              Başvuru referansı: <code>{id}</code>
            </p>
          ) : null}
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 18 }}>
            <Link className="btn btn-primary" href="/providers/me">Hizmet Veren Paneli</Link>
            <Link className="btn btn-ghost" href="/">Ana sayfa</Link>
          </div>
        </section>
      </div>
    </main>
  );
}

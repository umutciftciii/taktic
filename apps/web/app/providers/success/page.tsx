import Link from 'next/link';

type ProviderSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

export default async function ProviderSuccessPage({ searchParams }: ProviderSuccessPageProps) {
  const { id } = await searchParams;

  return (
    <main>
      <h1>Başvurunuz alındı ve ön incelemeye gönderildi.</h1>
      {id ? <p>Başvuru referansı: {id}</p> : null}
      <p>Bu fazda hizmet veren paneli ve teklif akışı henüz aktif değildir.</p>
      {id ? (
        <p>
          Başvurunuz onaylandığında geliştirme akışında <Link href={`/providers/${id}/requests`}>eşleşen talepler</Link>{' '}
          sayfasını kullanabilirsiniz.
        </p>
      ) : null}
      <p>
        <Link href="/">Ana sayfaya dön</Link>
      </p>
    </main>
  );
}

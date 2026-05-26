import Link from 'next/link';

type RequestSuccessPageProps = {
  searchParams: Promise<{ id?: string }>;
};

export default async function RequestSuccessPage({ searchParams }: RequestSuccessPageProps) {
  const { id } = await searchParams;

  return (
    <main>
      <h1>Talebiniz alındı.</h1>
      {id ? <p>Talep referansi: {id}</p> : null}
      <p>Bu fazda hizmet veren teklif akışı henüz aktif değildir.</p>
      <p>
        <Link href="/categories">Kategorilere don</Link>
      </p>
    </main>
  );
}

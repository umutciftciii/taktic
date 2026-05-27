import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>TakTic</h1>
      <p>Local services marketplace foundation.</p>
      <p>
        <Link href="/categories">Hizmet kategorilerini gor</Link>
      </p>
      <p>
        <Link href="/register/customer">Müşteri hesabı oluştur</Link>
      </p>
      <p>
        <Link href="/requests/my">Taleplerim</Link>
      </p>
      <p>
        <Link href="/register/provider">Hizmet veren hesabı oluştur</Link>
      </p>
      <p>
        <Link href="/providers/register">Hizmet veren başvurusu yap</Link>
      </p>
      <p>
        <Link href="/providers/me">Hizmet veren profilim</Link>
      </p>
    </main>
  );
}

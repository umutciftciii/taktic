import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>TakTic</h1>
      <p>Local services marketplace foundation.</p>
      <p className="nav-links">
        <Link href="/categories">Hizmet kategorilerini gör</Link>
        <Link href="/requests/my">Taleplerim</Link>
        <Link href="/providers/me">Hizmet veren panelim</Link>
      </p>
      <p className="nav-links">
        <Link href="/register/customer">Müşteri hesabı oluştur</Link>
        <Link href="/register/provider">Hizmet veren hesabı oluştur</Link>
        <Link href="/providers/register">Hizmet veren başvurusu yap</Link>
      </p>
    </main>
  );
}

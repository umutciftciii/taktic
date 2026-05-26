import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>TakTic</h1>
      <p>Local services marketplace foundation.</p>
      <p>
        <Link href="/categories">Hizmet kategorilerini gor</Link>
      </p>
    </main>
  );
}

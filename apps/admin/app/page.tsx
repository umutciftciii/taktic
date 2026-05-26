import Link from 'next/link';

export default function AdminHomePage() {
  return (
    <main>
      <h1>TakTic Admin</h1>
      <p>Admin foundation.</p>
      <p>
        <Link href="/categories">Manage categories</Link>
      </p>
    </main>
  );
}

import Link from 'next/link';

export default function AdminHomePage() {
  return (
    <main>
      <h1>TakTic Admin</h1>
      <p>Admin foundation.</p>
      <p>
        <Link href="/categories">Manage categories</Link>
      </p>
      <p>
        <Link href="/requests">Review service requests</Link>
      </p>
      <p>
        <Link href="/providers">Review providers</Link>
      </p>
      <p>
        <Link href="/offers">Review offers</Link>
      </p>
      <p>
        <Link href="/credit-packages">Manage credit packages</Link>
      </p>
    </main>
  );
}

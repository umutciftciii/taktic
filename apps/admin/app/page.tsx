import Link from 'next/link';
import { requireAdmin } from '../lib/api';
import { logoutAction } from './login/actions';

export default async function AdminHomePage() {
  const user = await requireAdmin();

  return (
    <main>
      <h1>TakTic Admin</h1>
      <p>Admin foundation. Logged in as {user.email}.</p>
      <form action={logoutAction}>
        <button type="submit">Logout</button>
      </form>
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
      <p>
        <Link href="/refund-scan">Refund Scan</Link>
      </p>
    </main>
  );
}

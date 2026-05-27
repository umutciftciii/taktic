import Link from 'next/link';
import { AdminSummary, apiFetch, requireAdmin } from '../lib/api';
import { logoutAction } from './login/actions';

export default async function AdminHomePage() {
  const user = await requireAdmin();
  const summary = await apiFetch<AdminSummary>('/dashboard/admin-summary');

  return (
    <main>
      <h1>TakTic Admin</h1>
      <p>Admin foundation. Logged in as {user.email}.</p>
      <form action={logoutAction}>
        <button type="submit">Logout</button>
      </form>

      <section className="summary-grid">
        <SummaryCard label="Toplam Talepler" value={summary.totalRequests} href="/requests" />
        <SummaryCard label="Bekleyen Talepler" value={summary.pendingRequests} href="/requests" />
        <SummaryCard label="İncelemedeki Talepler" value={summary.inReviewRequests} href="/requests" />
        <SummaryCard label="Onaylı Sağlayıcılar" value={summary.approvedProviders} href="/providers" />
        <SummaryCard label="Bekleyen Sağlayıcılar" value={summary.pendingProviders} href="/providers" />
        <SummaryCard label="Toplam Teklifler" value={summary.totalOffers} href="/offers" />
        <SummaryCard label="İade Adayları" value={summary.refundableOffers} href="/refund-scan" />
        <SummaryCard label="Paket Satın Almaları" value={summary.packagePurchases} href="/package-purchases" />
      </section>

      <section>
        <h2>Navigation</h2>
        <p className="nav-links">
          <Link href="/categories">Manage categories</Link>
          <Link href="/requests">Review service requests</Link>
          <Link href="/providers">Review providers</Link>
          <Link href="/offers">Review offers</Link>
          <Link href="/credit-packages">Manage credit packages</Link>
          <Link href="/package-purchases">Package purchases</Link>
          <Link href="/refund-scan">Refund Scan</Link>
        </p>
      </section>
    </main>
  );
}

function SummaryCard({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link className="summary-card" href={href}>
      <span className="muted">{label}</span>
      <span className="metric">{value}</span>
    </Link>
  );
}

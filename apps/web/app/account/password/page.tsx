import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/api';
import { CustomerShell } from '../../requests/customer-shell';

export default async function AccountPasswordPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/account/password');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  return (
    <CustomerShell user={user} active="settings">
      <header className="cdash-page-head">
        <h1 className="cdash-page-title">Şifre Değiştir</h1>
        <p className="cdash-page-sub">Hesap güvenliğinizle ilgili işlemler bu bölümde yer alacak.</p>
      </header>

      <section className="cdash-card" aria-label="Şifre değiştirme">
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text)' }}>
          Şifre değiştirme yakında aktif olacak.
        </p>
      </section>
    </CustomerShell>
  );
}

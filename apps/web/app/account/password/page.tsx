import Link from 'next/link';
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
        <span className="kicker">Hesap</span>
        <h1 className="cdash-page-title">Şifre değiştir</h1>
        <p className="cdash-page-sub">Hesap güvenliğinizle ilgili işlemler bu bölümde yer alacak.</p>
      </header>

      {/*
        No password-change endpoint exists yet. The screen says so instead of
        rendering a form that would fail on submit.
      */}
      <div className="cdash-empty">
        <h3>Şifre değiştirme yakında</h3>
        <p>
          Bu özellik hazır olduğunda buradan kendi şifrenizi güncelleyebileceksiniz. Şu an için
          giriş bilgilerinizle ilgili bir sorun yaşarsanız destekle iletişime geçin.
        </p>
        <Link className="cdash-btn cdash-btn-secondary" href="/account/profile">
          Profil bilgilerine dön
        </Link>
      </div>
    </CustomerShell>
  );
}

import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/api';
import { CustomerShell } from '../../requests/customer-shell';

const ROLE_LABELS: Record<string, string> = {
  CUSTOMER: 'Müşteri',
  PROVIDER: 'Hizmet veren',
  SUPER_ADMIN: 'Yönetici',
};

export default async function AccountProfilePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/account/profile');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  const name = (user.name && user.name.trim()) || '—';
  const email = user.email || '—';
  const phone = user.phone || '—';
  const role = ROLE_LABELS[user.role] ?? user.role;

  return (
    <CustomerShell user={user} active="settings">
      <header className="cdash-page-head">
        <h1 className="cdash-page-title">Profil Bilgileri</h1>
        <p className="cdash-page-sub">Hesabınıza kayıtlı bilgileri buradan görüntüleyebilirsiniz.</p>
      </header>

      <section className="cdash-card" aria-label="Hesap bilgileri">
        <dl className="cdash-info-grid">
          <div className="cdash-info-row">
            <dt>Ad Soyad</dt>
            <dd>{name}</dd>
          </div>
          <div className="cdash-info-row">
            <dt>E-posta</dt>
            <dd>{email}</dd>
          </div>
          <div className="cdash-info-row">
            <dt>Telefon</dt>
            <dd>{phone}</dd>
          </div>
          <div className="cdash-info-row">
            <dt>Rol</dt>
            <dd>{role}</dd>
          </div>
        </dl>
        <p className="cdash-page-sub" style={{ marginTop: 16 }}>
          Düzenleme özelliği yakında aktif olacak.
        </p>
      </section>
    </CustomerShell>
  );
}

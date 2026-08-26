import Link from 'next/link';
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
        <span className="kicker">Hesap</span>
        <h1 className="cdash-page-title">Profil ve ayarlar</h1>
        <p className="cdash-page-sub">Hesabınıza kayıtlı bilgileri buradan görüntüleyebilirsiniz.</p>
      </header>

      <div className="split">
        <div className="split-main">
          <section className="cdash-detail-card" aria-label="Kişisel bilgiler">
            <h2>Kişisel bilgiler</h2>
            <dl className="cdash-info-grid">
              <div className="cdash-info-row">
                <dt>Ad soyad</dt>
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
            {/*
              Read-only on purpose: there is no account-update endpoint yet, and
              a form that cannot save would be a promise the product does not keep.
            */}
            <p className="cdash-page-sub">Profil düzenleme yakında aktif olacak.</p>
          </section>

          <section className="cdash-detail-card" aria-label="Güvenlik">
            <h2>Güvenlik</h2>
            <p className="cdash-page-sub" style={{ margin: 0 }}>
              Şifre değiştirme ve oturum güvenliği ayarları ayrı bir ekranda toplanıyor.
            </p>
            <div className="inline-actions">
              <Link className="cdash-btn cdash-btn-secondary" href="/account/password">
                Şifre değiştir
              </Link>
            </div>
          </section>
        </div>

        <aside className="split-rail" aria-label="Hesap kartı">
          <div className="rail-panel">
            <span className="avatar-sq" style={{ width: 64, height: 64, fontSize: 20 }} aria-hidden="true">
              {initialsOf(name === '—' ? email : name)}
            </span>
            <div>
              <div className="cdash-brand-title">{name === '—' ? email : name}</div>
              <div className="cdash-brand-sub">{role}</div>
            </div>
          </div>

          <div className="rail-note">
            <strong>Veri ve gizlilik.</strong> İletişim bilgileriniz yalnızca bir teklifi kabul
            ettiğinizde, eşleştiğiniz hizmet verenle paylaşılır ve paylaşım kaydı tutulur.
          </div>
        </aside>
      </div>
    </CustomerShell>
  );
}

function initialsOf(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'M';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'M';
}

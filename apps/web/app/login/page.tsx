import Link from 'next/link';
import { getCurrentUser } from '../../lib/api';
import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    redirectTo?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, redirectTo } = await searchParams;
  const user = await getCurrentUser();

  return (
    <main className="auth-page">
      <form className="auth-card" action={loginAction}>
        <h1 className="auth-title">Giriş</h1>
        <p className="muted">Müşteri ve hizmet veren hesapları için giriş yapın.</p>
        {user ? (
          <div className="notice" style={{ marginTop: 8 }}>
            Şu an giriş yaptınız: <strong>{user.email ?? user.name ?? user.id}</strong> ({user.role})
          </div>
        ) : null}
        {error ? (
          <div className="error-message" style={{ marginTop: 8 }}>
            Giriş bilgileri geçersiz veya kullanıcı aktif değil.
          </div>
        ) : null}
        <input type="hidden" name="redirectTo" value={redirectTo ?? '/'} />
        <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
          <label className="form-row">
            <span>E-posta</span>
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className="form-row">
            <span>Şifre</span>
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          <button className="btn btn-primary btn-block" type="submit">Giriş Yap</button>
        </div>
        <div className="inline-actions" style={{ marginTop: 14, justifyContent: 'center' }}>
          <Link href="/register/customer">Müşteri hesabı oluştur</Link>
          <span className="muted">·</span>
          <Link href="/register/provider">Hizmet veren hesabı oluştur</Link>
        </div>
      </form>
    </main>
  );
}

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
          <p className="notice">
            Şu an giriş yaptınız: {user.email ?? user.name ?? user.id} ({user.role})
          </p>
        ) : null}
        {error ? <p className="error-message">Giriş bilgileri geçersiz veya kullanıcı aktif değil.</p> : null}
        <input type="hidden" name="redirectTo" value={redirectTo ?? '/'} />
        <p>
          <label>
            E-posta
            <input name="email" type="email" required />
          </label>
        </p>
        <p>
          <label>
            Şifre
            <input name="password" type="password" required />
          </label>
        </p>
        <button className="button-full" type="submit">Giriş Yap</button>
        <p className="actions">
          <Link href="/register/customer">Müşteri hesabı oluştur</Link>
          <Link href="/register/provider">Hizmet veren hesabı oluştur</Link>
        </p>
      </form>
    </main>
  );
}

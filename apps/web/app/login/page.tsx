import Link from 'next/link';
import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    redirectTo?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, redirectTo } = await searchParams;

  return (
    <main className="auth-screen">
      <form className="auth-screen-card auth-screen-card-compact" action={loginAction}>
        <img className="auth-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <h1 className="auth-screen-title">Giriş</h1>
        <p className="auth-screen-subtitle">
          Müşteri ve hizmet veren hesapları için giriş yapın.
        </p>

        {error ? (
          <div className="auth-screen-error" role="alert">
            E-posta veya şifre hatalı. Lütfen tekrar deneyin.
          </div>
        ) : null}

        {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}

        <div className="auth-screen-fields">
          <label className="auth-screen-field">
            <span className="auth-screen-label">E-posta</span>
            <input
              className="auth-screen-input"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="ornek@email.com"
            />
          </label>
          <label className="auth-screen-field">
            <span className="auth-screen-label">Şifre</span>
            <input
              className="auth-screen-input"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </label>
        </div>

        <button className="auth-screen-submit" type="submit">
          Giriş Yap
        </button>

        <hr className="auth-screen-divider" />

        <p className="auth-screen-alt-title">Henüz hesabınız yok mu?</p>
        <div className="auth-screen-alt-actions">
          <Link className="auth-screen-alt-btn" href="/register/customer">
            Müşteri Kaydı
          </Link>
          <Link className="auth-screen-alt-btn" href="/register/provider">
            Hizmet Veren Kaydı
          </Link>
        </div>
      </form>

      <p className="auth-screen-support">
        Yardıma mı ihtiyacınız var? Destek ile iletişime geçin.
      </p>
    </main>
  );
}

import { safeRedirectPathOrNull } from '@taktic/shared';
import Link from 'next/link';
import { AuthFrame } from '../auth-frame';
import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    redirectTo?: string;
    reason?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, redirectTo, reason } = await searchParams;
  // The address bar decides what is in `redirectTo`, and whatever is there is
  // about to be written into a hidden field this form posts back. Anything that
  // is not a path inside this application is dropped here rather than carried
  // one step further; see @taktic/shared's safe-redirect.
  const safeRedirectTo = safeRedirectPathOrNull(redirectTo);
  // Somebody who was signed in a moment ago and is suddenly back here deserves
  // to know why. Without it, an idle timeout is indistinguishable from being
  // logged out at random, and the natural conclusion is that the site broke.
  const sessionEnded = reason === 'session-expired';

  return (
    <AuthFrame tab="login">
      <form action={loginAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 className="auth-screen-title">Tekrar hoş geldin</h1>
        <p className="auth-screen-subtitle">
          Müşteri ve hizmet veren hesapları için giriş yapın.
        </p>

        {error ? (
          <div className="auth-screen-error" role="alert">
            E-posta veya şifre hatalı. Lütfen tekrar deneyin.
          </div>
        ) : null}

        {sessionEnded && !error ? (
          <div className="auth-screen-notice" role="status" data-testid="session-expired-notice">
            Güvenliğiniz için, bir süre işlem yapılmadığından oturumunuz sonlandırıldı. Kaldığınız
            yerden devam etmek için tekrar giriş yapın.
          </div>
        ) : null}

        {safeRedirectTo ? (
          <input type="hidden" name="redirectTo" value={safeRedirectTo} />
        ) : null}

        <div className="auth-screen-fields">
          <label className="auth-screen-field">
            <span className="auth-screen-label">E-posta</span>
            <input
              className="auth-screen-input"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="ornek@eposta.com"
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

        {/*
          "Beni hatırla" changes how long the session may live and whether its
          cookie survives closing the browser — nothing more. Nothing is written
          to the browser's own storage: no password, no token, no identity. The
          session stays an HttpOnly cookie the page cannot read, and an idle
          half hour still ends it whether this is ticked or not.
        */}
        <label className="auth-screen-remember" htmlFor="rememberMe">
          <input id="rememberMe" type="checkbox" name="rememberMe" value="true" />
          <span>Beni hatırla</span>
        </label>

        <button className="auth-screen-submit" type="submit">
          Giriş Yap
        </button>

        <p className="auth-screen-support" style={{ marginTop: 0 }}>
          <Link href="/sifre-unuttum" style={{ textDecoration: 'underline' }}>
            Şifremi unuttum
          </Link>
        </p>

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

        <p className="auth-screen-support">
          Yardıma mı ihtiyacınız var? Destek ile iletişime geçin.
        </p>
      </form>
    </AuthFrame>
  );
}

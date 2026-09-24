import { BrandMark } from '../../components/brand-mark';
import { isLocalEnvironment } from '../../lib/local-environment';

type LoginPageProps = {
  searchParams: Promise<{ error?: string; reason?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, reason } = await searchParams;
  // An operator who was working a moment ago and is suddenly back here deserves
  // to know why. Without it, an idle timeout is indistinguishable from the
  // panel breaking.
  const sessionEnded = reason === 'session-expired';
  // The seeded local account's address and password are a convenience for a
  // developer's machine. Anywhere else they are a published credential, so
  // they are shown (and prefilled) on APP_ENVIRONMENT=local only.
  const showLocalHint = isLocalEnvironment();

  return (
    <main className="auth-page">
      {/*
        A plain HTML post to a fixed URL rather than a Server Action: a sign-in
        form left open across a deploy has to keep working. See login/submit.
      */}
      <form className="auth-card" action="/login/submit" method="post">
        <div className="auth-brand">
          <BrandMark size="lg" />
          <div className="auth-brand-text">
            <h1 className="auth-title">TakTick Yönetim</h1>
            <p className="auth-subtitle">Yönetim paneline giriş yapın</p>
          </div>
        </div>
        {error ? (
          <div className="error-message">Giriş başarısız. E-posta ve şifrenizi kontrol edin.</div>
        ) : null}
        {sessionEnded && !error ? (
          <div className="admin-session-notice" role="status" data-testid="session-expired-notice">
            Güvenliğiniz için, bir süre işlem yapılmadığından oturumunuz sonlandırıldı. Devam etmek
            için tekrar giriş yapın.
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
          <label className="form-row">
            <span>E-posta</span>
            <input name="email" type="email" defaultValue={showLocalHint ? 'admin@taktic.local' : undefined} required autoComplete="email" />
          </label>
          <label className="form-row">
            <span>Şifre</span>
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          {/*
            Changes how long the session may live and whether its cookie
            survives closing the browser — nothing more. Nothing is written to
            the browser's own storage: no password, no token, no identity. An
            idle half hour still ends the session either way.
          */}
          <label className="admin-remember" htmlFor="rememberMe">
            <input id="rememberMe" type="checkbox" name="rememberMe" value="true" />
            <span>Beni hatırla</span>
          </label>
          <button className="btn btn-primary btn-block" type="submit">Giriş Yap</button>
        </div>
        {showLocalHint ? (
          <p className="auth-footnote" data-testid="local-admin-hint">
            Yerel admin: <code>admin@taktic.local</code> / <code>ChangeMe123!</code>
          </p>
        ) : null}
      </form>
    </main>
  );
}

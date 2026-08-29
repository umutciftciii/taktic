import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{ error?: string; reason?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error, reason } = await searchParams;
  // An operator who was working a moment ago and is suddenly back here deserves
  // to know why. Without it, an idle timeout is indistinguishable from the
  // panel breaking.
  const sessionEnded = reason === 'session-expired';

  return (
    <main className="auth-page">
      <form className="auth-card" action={loginAction}>
        <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <h1 className="auth-title">TakTic Admin</h1>
        <p className="muted">Yönetim paneline giriş yapın</p>
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
            <input name="email" type="email" defaultValue="admin@taktic.local" required autoComplete="email" />
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
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          Yerel admin: <code>admin@taktic.local</code> / <code>ChangeMe123!</code>
        </p>
      </form>
    </main>
  );
}

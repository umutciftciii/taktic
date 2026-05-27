import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main className="auth-page">
      <form className="auth-card" action={loginAction}>
        <h1 className="auth-title">TakTic Admin</h1>
        <p className="muted">Yönetim paneline giriş yapın</p>
        {error ? (
          <div className="error-message">Giriş başarısız. E-posta ve şifrenizi kontrol edin.</div>
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
          <button className="btn btn-primary btn-block" type="submit">Giriş Yap</button>
        </div>
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          Yerel admin: <code>admin@taktic.local</code> / <code>ChangeMe123!</code>
        </p>
      </form>
    </main>
  );
}

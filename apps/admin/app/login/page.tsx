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
        {error ? <p className="error-message">Login failed. Check your email and password.</p> : null}
        <p>
          <label>
            Email
            <input name="email" type="email" defaultValue="admin@taktic.local" required />
          </label>
        </p>
        <p>
          <label>
            Password
            <input name="password" type="password" required />
          </label>
        </p>
        <button className="button-full" type="submit">Login</button>
        <p className="muted">Local admin: admin@taktic.local / ChangeMe123!</p>
      </form>
    </main>
  );
}

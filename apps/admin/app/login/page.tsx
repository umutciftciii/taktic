import { loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <main>
      <h1>TakTic Admin Login</h1>
      {error ? <p>Login failed. Check your email and password.</p> : null}
      <form action={loginAction}>
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
        <button type="submit">Login</button>
      </form>
    </main>
  );
}

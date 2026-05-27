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
    <main>
      <h1>Giriş</h1>
      <p>Provider ve müşteri geliştirme akışları için basit oturum girişi.</p>
      {error ? <p>Giriş bilgileri geçersiz veya kullanıcı aktif değil.</p> : null}
      <form action={loginAction}>
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
        <button type="submit">Giriş Yap</button>
      </form>
    </main>
  );
}

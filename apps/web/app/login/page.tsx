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
    <main>
      <h1>Giriş</h1>
      <p>Müşteri, hizmet veren ve admin hesapları için giriş.</p>
      {user ? (
        <p>
          Şu an giriş yaptınız: {user.email ?? user.name ?? user.id} ({user.role})
        </p>
      ) : null}
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
      <p>
        <Link href="/register/customer">Müşteri hesabı oluştur</Link> |{' '}
        <Link href="/register/provider">Hizmet veren hesabı oluştur</Link>
      </p>
    </main>
  );
}

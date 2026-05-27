import Link from 'next/link';
import { registerProviderAction } from '../actions';

type ProviderRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function ProviderRegisterPage({ searchParams }: ProviderRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>Hizmet Veren Hesabı Oluştur</h1>
      {error ? <p>{error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}</p> : null}
      <form action={registerProviderAction}>
        <p>
          <label>
            Yetkili adı *
            <input name="name" required />
          </label>
        </p>
        <p>
          <label>
            E-posta *
            <input name="email" type="email" required />
          </label>
        </p>
        <p>
          <label>
            Şifre *
            <input name="password" type="password" minLength={8} required />
          </label>
        </p>
        <p>
          <label>
            Telefon
            <input name="phone" />
          </label>
        </p>
        <button type="submit">Hesap Oluştur</button>
      </form>
      <p>
        Hesap oluşturduktan sonra <Link href="/providers/register">hizmet veren başvurusunu</Link> tamamlayın.
      </p>
    </main>
  );
}

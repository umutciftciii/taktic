import Link from 'next/link';
import { registerCustomerAction } from '../actions';

type CustomerRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function CustomerRegisterPage({ searchParams }: CustomerRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <main>
      <p>
        <Link href="/">Ana sayfa</Link>
      </p>
      <h1>Müşteri Hesabı Oluştur</h1>
      {error ? <p>{error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}</p> : null}
      <form action={registerCustomerAction}>
        <p>
          <label>
            Ad soyad *
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
    </main>
  );
}

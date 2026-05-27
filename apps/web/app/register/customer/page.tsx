import Link from 'next/link';
import { registerCustomerAction } from '../actions';

type CustomerRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function CustomerRegisterPage({ searchParams }: CustomerRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <main className="auth-page">
      <form className="auth-card" action={registerCustomerAction}>
        <p>
          <Link href="/">Ana sayfa</Link>
        </p>
        <h1 className="auth-title">Müşteri Hesabı Oluştur</h1>
        <p className="muted">Taleplerinizi takip etmek ve teklifleri tek yerde görmek için hesap açın.</p>
        {error ? (
          <p className="error-message">
            {error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}
          </p>
        ) : null}
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
        <button className="button-full" type="submit">Hesap Oluştur</button>
      </form>
    </main>
  );
}

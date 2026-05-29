import Link from 'next/link';
import { registerCustomerAction } from '../actions';

type CustomerRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function CustomerRegisterPage({ searchParams }: CustomerRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <main className="auth-screen">
      <form className="auth-screen-card auth-screen-card-compact" action={registerCustomerAction}>
        <div className="auth-screen-card-head">
          <h1 className="auth-screen-title">Müşteri Hesabı Oluştur</h1>
          <p className="auth-screen-subtitle">
            Taleplerinizi takip etmek ve teklifleri tek yerde görmek için hesap açın.
          </p>
        </div>

        {error ? (
          <div className="auth-screen-error" role="alert">
            {error === 'duplicate'
              ? 'Bu e-posta veya telefon zaten kayıtlı.'
              : 'Bilgileri kontrol edin.'}
          </div>
        ) : null}

        <div className="auth-screen-fields">
          <label className="auth-screen-field">
            <span className="auth-screen-label">Ad soyad *</span>
            <input
              className="auth-screen-input"
              name="name"
              required
              autoComplete="name"
            />
          </label>
          <label className="auth-screen-field">
            <span className="auth-screen-label">E-posta *</span>
            <input
              className="auth-screen-input"
              name="email"
              type="email"
              required
              autoComplete="email"
            />
          </label>
          <label className="auth-screen-field">
            <span className="auth-screen-label">Şifre *</span>
            <input
              className="auth-screen-input"
              name="password"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
            />
            <span className="auth-screen-help">En az 8 karakter.</span>
          </label>
          <label className="auth-screen-field">
            <span className="auth-screen-label">Telefon</span>
            <input
              className="auth-screen-input"
              name="phone"
              autoComplete="tel"
              placeholder="05XX XXX XX XX"
            />
          </label>
        </div>

        <button className="auth-screen-submit" type="submit">
          Hesap Oluştur
        </button>

        <p className="auth-screen-bottom-link">
          Zaten hesabınız var mı?
          <Link href="/login">Giriş yapın</Link>
        </p>
      </form>
    </main>
  );
}

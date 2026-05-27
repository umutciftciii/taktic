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
        <h1 className="auth-title">Müşteri Hesabı Oluştur</h1>
        <p className="muted">Taleplerinizi takip etmek ve teklifleri tek yerde görmek için hesap açın.</p>
        {error ? (
          <div className="error-message" style={{ marginTop: 8 }}>
            {error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
          <label className="form-row">
            <span>Ad soyad *</span>
            <input name="name" required autoComplete="name" />
          </label>
          <label className="form-row">
            <span>E-posta *</span>
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className="form-row">
            <span>Şifre *</span>
            <input name="password" type="password" minLength={8} required autoComplete="new-password" />
            <span className="help-text">En az 8 karakter.</span>
          </label>
          <label className="form-row">
            <span>Telefon</span>
            <input name="phone" autoComplete="tel" placeholder="05XX XXX XX XX" />
          </label>
          <button className="btn btn-primary btn-block" type="submit">Hesap Oluştur</button>
        </div>
        <div className="inline-actions" style={{ marginTop: 14, justifyContent: 'center' }}>
          <span className="muted">Zaten hesabınız var mı?</span>
          <Link href="/login">Giriş yapın</Link>
        </div>
      </form>
    </main>
  );
}

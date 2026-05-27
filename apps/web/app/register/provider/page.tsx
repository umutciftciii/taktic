import Link from 'next/link';
import { registerProviderAction } from '../actions';

type ProviderRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function ProviderRegisterPage({ searchParams }: ProviderRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <main className="auth-page">
      <form className="auth-card" action={registerProviderAction}>
        <h1 className="auth-title">Hizmet Veren Hesabı Oluştur</h1>
        <p className="muted">Profilinizi bağlamak ve teklif akışını yönetmek için hesap açın.</p>
        {error ? (
          <div className="error-message" style={{ marginTop: 8 }}>
            {error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
          <label className="form-row">
            <span>Yetkili adı *</span>
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
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
          Hesap oluşturduktan sonra <Link href="/providers/register">hizmet veren başvurusunu</Link> tamamlayın.
        </p>
        <div className="inline-actions" style={{ marginTop: 6, justifyContent: 'center' }}>
          <span className="muted">Zaten hesabınız var mı?</span>
          <Link href="/login">Giriş yapın</Link>
        </div>
      </form>
    </main>
  );
}

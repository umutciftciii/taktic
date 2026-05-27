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
        <p>
          <Link href="/">Ana sayfa</Link>
        </p>
        <h1 className="auth-title">Hizmet Veren Hesabı Oluştur</h1>
        <p className="muted">Profilinizi bağlamak ve teklif akışını yönetmek için hesap açın.</p>
        {error ? (
          <p className="error-message">
            {error === 'duplicate' ? 'Bu e-posta veya telefon zaten kayıtlı.' : 'Bilgileri kontrol edin.'}
          </p>
        ) : null}
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
        <button className="button-full" type="submit">Hesap Oluştur</button>
        <p className="muted">
          Hesap oluşturduktan sonra <Link href="/providers/register">hizmet veren başvurusunu</Link> tamamlayın.
        </p>
      </form>
    </main>
  );
}

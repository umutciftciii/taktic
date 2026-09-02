import Link from 'next/link';
import { AuthFrame } from '../../auth-frame';
import { registerProviderAction } from '../actions';
import { RoleSwitch } from '../role-switch';
import { registerErrorMessage } from '../error-message';
import { PasswordFields } from '../../password-criteria';

type ProviderRegisterPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function ProviderRegisterPage({ searchParams }: ProviderRegisterPageProps) {
  const { error } = await searchParams;

  return (
    <AuthFrame tab="register" registerHref="/register/provider">
      <form
        action={registerProviderAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <h1 className="auth-screen-title">Hesap oluştur</h1>
        <p className="auth-screen-subtitle">
          Profilinizi bağlamak ve teklif akışını yönetmek için hizmet veren hesabı açın.
        </p>

        <RoleSwitch active="provider" />

        {error ? (
          <div className="auth-screen-error" role="alert">
            {registerErrorMessage(error)}
          </div>
        ) : null}

        <div className="auth-screen-fields">
          <label className="auth-screen-field">
            <span className="auth-screen-label">Yetkili adı *</span>
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
            <span className="auth-screen-label">Telefon</span>
            <input
              className="auth-screen-input"
              name="phone"
              autoComplete="tel"
              placeholder="05XX XXX XX XX"
            />
          </label>
          {/*
            One field, so no matching criterion — the register endpoint asks for
            a password once. The length rule shown is the API's own.
          */}
          <PasswordFields withConfirm={false} labels={{ password: 'Şifre *' }} />
        </div>

        <button className="auth-screen-submit" type="submit">
          Hesap Oluştur
        </button>

        <hr className="auth-screen-divider" />

        <p className="auth-screen-hint">
          Hesap oluşturduktan sonra <Link href="/providers/register">hizmet veren başvurusunu</Link>{' '}
          tamamlayın.
        </p>
        <p className="auth-screen-bottom-link">
          Zaten hesabınız var mı?
          <Link href="/login">Giriş yapın</Link>
        </p>
      </form>
    </AuthFrame>
  );
}

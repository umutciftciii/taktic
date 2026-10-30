import Link from 'next/link';
import { AuthFrame } from '../auth-frame';
import { TurnstileForm } from '../request-fields/turnstile-form';
import {
  CREDENTIAL_REFUSAL_MESSAGES,
  TURNSTILE_ACTIONS,
  isCredentialRefusal,
  readTurnstileWebConfig,
} from '../../lib/turnstile';

type ForgotPasswordPageProps = {
  searchParams: Promise<{ sent?: string; error?: string }>;
};

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const { sent, error } = await searchParams;

  if (sent === '1') {
    return (
      <AuthFrame tab="login">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 className="auth-screen-title">Bağlantı gönderildi</h1>
          {/*
            Worded so it is true either way. The API never says whether an
            address is registered, and neither may this screen.
          */}
          <p className="auth-screen-subtitle">
            Girdiğiniz adres bir TakTick hesabına aitse şifre sıfırlama bağlantısını gönderdik.
            Bağlantı 30 dakika boyunca geçerlidir.
          </p>
          <Link className="auth-screen-submit" href="/login" style={{ textAlign: 'center' }}>
            Giriş ekranına dön
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame tab="login">
      <TurnstileForm
        turnstile={readTurnstileWebConfig()}
        turnstileAction={TURNSTILE_ACTIONS.passwordReset}
        action="/sifre-unuttum/submit"
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        testId="password-reset-request-form"
      >
        <h1 className="auth-screen-title">Şifrenizi mi unuttunuz?</h1>
        <p className="auth-screen-subtitle">
          Hesabınızın e-posta adresini girin; şifrenizi yeniden belirlemeniz için bir bağlantı
          gönderelim.
        </p>

        {/*
          Only the security check and the throttle can fail visibly here, and
          neither depends on the address typed — so this says nothing about
          whether it is registered.
        */}
        {isCredentialRefusal(error) ? (
          <div className="auth-screen-error" role="alert" data-testid="password-reset-error">
            {CREDENTIAL_REFUSAL_MESSAGES[error]}
          </div>
        ) : null}

        <div className="auth-screen-fields">
          <label className="auth-screen-field">
            <span className="auth-screen-label">E-posta</span>
            <input
              className="auth-screen-input"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="ornek@eposta.com"
            />
          </label>
        </div>

        <button className="auth-screen-submit" type="submit">
          Sıfırlama Bağlantısı Gönder
        </button>

        <p className="auth-screen-support">
          Şifrenizi hatırladınız mı?{' '}
          <Link href="/login" style={{ textDecoration: 'underline' }}>
            Giriş yapın
          </Link>
          .
        </p>
      </TurnstileForm>
    </AuthFrame>
  );
}

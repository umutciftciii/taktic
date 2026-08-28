import { formatDateTime } from '@taktic/shared';
import Link from 'next/link';
import { AuthFrame } from '../auth-frame';
import { apiUrl, readApiMessage } from '../api-base';
import { PASSWORD_MIN_LENGTH } from '../../lib/password-policy';
import { PasswordFields } from '../password-criteria';
import { confirmPasswordResetAction } from './actions';

type ResetPasswordPageProps = {
  searchParams: Promise<{
    token?: string;
    success?: string;
    error?: string;
    errorMessage?: string;
  }>;
};

type ValidateResult =
  | { kind: 'ok'; email: string | null; expiresAt: string }
  | { kind: 'error'; message: string };

async function validateResetToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(
      `${apiUrl}/auth/password-reset?token=${encodeURIComponent(token)}`,
      { cache: 'no-store', headers: { accept: 'application/json' } },
    );

    if (!response.ok) {
      const message = await readApiMessage(response);
      return { kind: 'error', message: message ?? 'Bağlantı geçersiz veya süresi dolmuş.' };
    }

    const payload = (await response.json()) as { email: string | null; expiresAt: string };
    return { kind: 'ok', email: payload.email, expiresAt: payload.expiresAt };
  } catch {
    return { kind: 'error', message: 'Bağlantı doğrulanamadı. Lütfen tekrar deneyin.' };
  }
}

/**
 * The product's own zone, never the process's. A server running in UTC must not
 * tell an Istanbul visitor their link expires three hours earlier than it does.
 */
const formatExpiry = formatDateTime;

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const { token, success, error, errorMessage } = await searchParams;

  if (success === '1') {
    return (
      <AuthFrame tab="login">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 className="auth-screen-title">Şifreniz güncellendi</h1>
          <p className="auth-screen-subtitle">
            Güvenliğiniz için açık olan tüm oturumlar kapatıldı. Yeni şifrenizle giriş
            yapabilirsiniz.
          </p>
          <Link className="auth-screen-submit" href="/login" style={{ textAlign: 'center' }}>
            Giriş Yap
          </Link>
        </div>
      </AuthFrame>
    );
  }

  const trimmedToken = token?.trim();
  const result = trimmedToken
    ? await validateResetToken(trimmedToken)
    : ({ kind: 'error', message: 'Sıfırlama bağlantısı bulunamadı.' } as const);

  if (result.kind === 'error') {
    return (
      <AuthFrame tab="login">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 className="auth-screen-title">Bağlantı geçersiz</h1>
          <p className="auth-screen-subtitle">{result.message}</p>
          <Link className="auth-screen-submit" href="/sifre-unuttum" style={{ textAlign: 'center' }}>
            Yeni Bağlantı İste
          </Link>
        </div>
      </AuthFrame>
    );
  }

  const fieldError =
    error === 'password'
      ? `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalıdır.`
      : error === 'mismatch'
        ? 'Şifreler eşleşmiyor.'
        : error === 'submit'
          ? errorMessage || 'Şifre belirlenemedi. Bağlantınız geçersiz veya süresi dolmuş olabilir.'
          : null;

  return (
    <AuthFrame tab="login">
      <form
        action={confirmPasswordResetAction}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <h1 className="auth-screen-title">Yeni şifre belirleyin</h1>
        <p className="auth-screen-subtitle">
          {result.email ? `${result.email} hesabı için ` : ''}yeni bir şifre seçin.
        </p>

        <div className="auth-screen-fields">
          <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            Bağlantı son geçerlilik: {formatExpiry(result.expiresAt)}
          </div>
        </div>

        {fieldError ? (
          <div className="auth-screen-error" role="alert">
            {fieldError}
          </div>
        ) : null}

        <input type="hidden" name="token" value={trimmedToken} />

        <div className="auth-screen-fields">
          <PasswordFields />
        </div>

        <button className="auth-screen-submit" type="submit">
          Şifreyi Kaydet
        </button>
      </form>
    </AuthFrame>
  );
}

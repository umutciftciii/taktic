import { formatDateTime } from '@taktic/shared';
import Link from 'next/link';
import { BrandMark } from '../../components/brand-mark';
import { passwordRuleMessage } from '../../lib/password-policy';
import { PasswordFields } from '../password-criteria';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type ResetPasswordPageProps = {
  searchParams: Promise<{ token?: string; success?: string; error?: string; rule?: string }>;
};

type ValidateResult =
  | { kind: 'ok'; email: string | null; expiresAt: string }
  | { kind: 'error'; message: string };

/** One message for every refusal, as the API gives one: which it was is not shown. */
const INVALID_LINK = 'Bağlantı geçersiz veya süresi dolmuş.';

async function validateResetToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(
      `${apiUrl}/auth/password-reset?token=${encodeURIComponent(token)}`,
      { cache: 'no-store', headers: { accept: 'application/json' } },
    );

    if (!response.ok) {
      return { kind: 'error', message: INVALID_LINK };
    }

    const payload = (await response.json()) as { email: string | null; expiresAt: string };
    return { kind: 'ok', email: payload.email, expiresAt: payload.expiresAt };
  } catch {
    return { kind: 'error', message: 'Bağlantı doğrulanamadı. Lütfen tekrar deneyin.' };
  }
}

/**
 * ADMIN-AUTH-001: where a staff account's reset link lands.
 *
 * The product's own zone for the expiry, never the process's: a server
 * running in UTC must not tell an Istanbul operator their link expires three
 * hours earlier than it does.
 */
export default async function AdminResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const { token, success, error, rule } = await searchParams;

  if (success === '1') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size="lg" />
            <div className="auth-brand-text">
              <h1 className="auth-title">Şifreniz güncellendi</h1>
              <p className="auth-subtitle">TakTick Yönetim</p>
            </div>
          </div>
          <p className="muted" role="status">
            Güvenliğiniz için açık olan tüm oturumlarınız kapatıldı. Yeni şifrenizle giriş
            yapabilirsiniz.
          </p>
          <Link className="btn btn-primary btn-block" href="/login" style={{ marginTop: 16 }}>
            Giriş Yap
          </Link>
        </div>
      </main>
    );
  }

  const trimmedToken = token?.trim();
  const result: ValidateResult = trimmedToken
    ? await validateResetToken(trimmedToken)
    : { kind: 'error', message: 'Sıfırlama bağlantısı bulunamadı.' };

  if (result.kind === 'error') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size="lg" />
            <div className="auth-brand-text">
              <h1 className="auth-title">Bağlantı geçersiz</h1>
              <p className="auth-subtitle">TakTick Yönetim</p>
            </div>
          </div>
          <p className="muted">{result.message}</p>
          <Link
            className="btn btn-primary btn-block"
            href="/sifre-unuttum"
            style={{ marginTop: 16 }}
          >
            Yeni Bağlantı İste
          </Link>
        </div>
      </main>
    );
  }

  const fieldError =
    error === 'policy' || error === 'password'
      ? passwordRuleMessage(rule)
      : error === 'mismatch'
        ? 'Şifreler eşleşmiyor.'
        : error === 'submit'
          ? 'Şifre belirlenemedi. Bağlantınız geçersiz veya süresi dolmuş olabilir.'
          : null;

  return (
    <main className="auth-page">
      <form className="auth-card" action="/sifre-sifirla/submit" method="post">
        <div className="auth-brand">
          <BrandMark size="lg" />
          <div className="auth-brand-text">
            <h1 className="auth-title">Yeni şifre belirleyin</h1>
            <p className="auth-subtitle">TakTick Yönetim</p>
          </div>
        </div>

        <div className="auth-meta">
          {result.email ? <div>E-posta: {result.email}</div> : null}
          <div className="auth-meta-note">
            Bağlantı son geçerlilik: {formatDateTime(result.expiresAt)}
          </div>
        </div>

        {fieldError ? (
          <div className="error-message" role="alert" style={{ marginTop: 12 }}>
            {fieldError}
          </div>
        ) : null}

        <input type="hidden" name="token" value={trimmedToken} />

        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <PasswordFields />
          <button className="btn btn-primary btn-block" type="submit">
            Şifreyi Kaydet
          </button>
        </div>

        <p className="auth-footnote">
          Kaydettiğinizde açık olan tüm oturumlarınız kapatılır.{' '}
          <Link href="/login" style={{ textDecoration: 'underline' }}>
            Giriş ekranına dön
          </Link>
          .
        </p>
      </form>
    </main>
  );
}

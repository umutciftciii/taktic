import { formatDateTime } from '@taktic/shared';
import Link from 'next/link';
import { PASSWORD_MIN_LENGTH } from '../../lib/password-policy';
import { PasswordFields } from '../password-criteria';
import { submitCustomerActivationAction } from './actions';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type SearchParams = {
  token?: string;
  success?: string;
  error?: string;
  errorMessage?: string;
};

type ActivateCustomerPageProps = {
  searchParams: Promise<SearchParams>;
};

type ValidateSuccess = {
  valid: true;
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  expiresAt: string;
};

type ValidateResult =
  | { kind: 'ok'; payload: ValidateSuccess }
  | { kind: 'error'; message: string };

async function validateActivationToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(
      `${apiUrl}/auth/customer-activation?token=${encodeURIComponent(token)}`,
      {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      },
    );

    if (!response.ok) {
      const message = await safeReadMessage(response);
      return { kind: 'error', message: message ?? 'Bağlantı geçersiz veya süresi dolmuş.' };
    }

    const payload = (await response.json()) as ValidateSuccess;
    return { kind: 'ok', payload };
  } catch {
    return { kind: 'error', message: 'Bağlantı doğrulanamadı. Lütfen tekrar deneyin.' };
  }
}

async function safeReadMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed?.message === 'string') return parsed.message;
      if (Array.isArray(parsed?.message) && typeof parsed.message[0] === 'string') {
        return parsed.message[0];
      }
    } catch {
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The product's own zone, never the process's. A server running in UTC must not
 * tell an Istanbul visitor their link expires three hours earlier than it does.
 */
const formatExpiry = formatDateTime;

export default async function ActivateCustomerPage({ searchParams }: ActivateCustomerPageProps) {
  const { token, success, error, errorMessage } = await searchParams;

  if (success === '1') {
    return (
      <main className="auth-screen">
        <div className="auth-screen-card auth-screen-card-compact">
          <img className="auth-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-screen-title">Şifreniz oluşturuldu</h1>
          <p className="auth-screen-subtitle">
            Artık e-posta ve şifrenizle giriş yapabilirsiniz.
          </p>
          <Link className="auth-screen-submit" href="/login" style={{ textAlign: 'center' }}>
            Giriş Yap
          </Link>
        </div>
      </main>
    );
  }

  if (!token || !token.trim()) {
    return (
      <main className="auth-screen">
        <div className="auth-screen-card auth-screen-card-compact">
          <img className="auth-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-screen-title">Bağlantı geçersiz</h1>
          <p className="auth-screen-subtitle">
            Aktivasyon bağlantısı bulunamadı. Lütfen size gönderilen bağlantıyı kontrol edin.
          </p>
          <Link className="auth-screen-submit" href="/" style={{ textAlign: 'center' }}>
            Ana sayfaya dön
          </Link>
        </div>
      </main>
    );
  }

  const result = await validateActivationToken(token);

  if (result.kind === 'error') {
    return (
      <main className="auth-screen">
        <div className="auth-screen-card auth-screen-card-compact">
          <img className="auth-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-screen-title">Bağlantı geçersiz</h1>
          <p className="auth-screen-subtitle">{result.message}</p>
          <Link className="auth-screen-submit" href="/" style={{ textAlign: 'center' }}>
            Ana sayfaya dön
          </Link>
        </div>
      </main>
    );
  }

  const { customer, expiresAt } = result.payload;
  const displayName = customer.name ?? customer.email ?? customer.phone ?? 'Müşteri';

  const fieldError =
    error === 'password'
      ? `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalıdır.`
      : error === 'mismatch'
        ? 'Şifreler eşleşmiyor.'
        : error === 'submit'
          ? errorMessage || 'Şifre belirlenemedi. Bağlantınız geçersiz veya süresi dolmuş olabilir.'
          : null;

  return (
    <main className="auth-screen">
      <form className="auth-screen-card auth-screen-card-compact" action={submitCustomerActivationAction}>
        <img className="auth-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <h1 className="auth-screen-title">Şifre belirleyin</h1>
        <p className="auth-screen-subtitle">
          Merhaba {displayName}, TakTick hesabınızı kullanmaya başlamak için bir şifre belirleyin.
        </p>

        <div className="auth-screen-fields">
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-neutral-800)' }}>
            {customer.email ? <div>E-posta: {customer.email}</div> : null}
            {customer.phone ? <div>Telefon: {customer.phone}</div> : null}
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-neutral-700)' }}>
              Bağlantı son geçerlilik: {formatExpiry(expiresAt)}
            </div>
          </div>
        </div>

        {fieldError ? (
          <div className="auth-screen-error" role="alert">
            {fieldError}
          </div>
        ) : null}

        <input type="hidden" name="token" value={token} />

        <div className="auth-screen-fields">
          <PasswordFields />
        </div>

        <button className="auth-screen-submit" type="submit">
          Şifreyi Kaydet
        </button>

        <p className="auth-screen-support" style={{ marginTop: 16 }}>
          Zaten şifreniz var mı?{' '}
          <Link href="/login" style={{ textDecoration: 'underline' }}>
            Giriş yapın
          </Link>
          .
        </p>
      </form>
    </main>
  );
}

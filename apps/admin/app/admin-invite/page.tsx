import Link from 'next/link';
import { submitAdminInviteAction } from './actions';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type SearchParams = {
  token?: string;
  success?: string;
  error?: string;
  errorMessage?: string;
};

type AdminInvitePageProps = {
  searchParams: Promise<SearchParams>;
};

type ValidateSuccess = {
  valid: true;
  user: {
    name: string | null;
    email: string | null;
  };
  expiresAt: string;
};

type ValidateResult =
  | { kind: 'ok'; payload: ValidateSuccess }
  | { kind: 'error'; message: string };

async function validateInviteToken(token: string): Promise<ValidateResult> {
  try {
    const response = await fetch(
      `${apiUrl}/auth/admin-invite?token=${encodeURIComponent(token)}`,
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

function formatExpiry(value: string): string {
  try {
    return new Date(value).toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

export default async function AdminInvitePage({ searchParams }: AdminInvitePageProps) {
  const { token, success, error, errorMessage } = await searchParams;

  if (success === '1') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-title">Şifreniz oluşturuldu</h1>
          <p className="muted">Admin paneline giriş yapabilirsiniz.</p>
          <Link className="btn btn-primary btn-block" href="/login" style={{ marginTop: 16 }}>
            Giriş Yap
          </Link>
        </div>
      </main>
    );
  }

  if (!token || !token.trim()) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-title">Bağlantı geçersiz</h1>
          <p className="muted">
            Davet bağlantısı bulunamadı. Lütfen size gönderilen bağlantıyı kontrol edin.
          </p>
        </div>
      </main>
    );
  }

  const result = await validateInviteToken(token);

  if (result.kind === 'error') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
          <h1 className="auth-title">Bağlantı geçersiz</h1>
          <p className="muted">{result.message}</p>
        </div>
      </main>
    );
  }

  const { user, expiresAt } = result.payload;
  const displayName = user.name ?? user.email ?? 'Admin';

  const fieldError =
    error === 'password'
      ? 'Şifre en az 8 karakter olmalıdır.'
      : error === 'mismatch'
        ? 'Şifreler eşleşmiyor.'
        : error === 'submit'
          ? errorMessage || 'Şifre belirlenemedi. Bağlantınız geçersiz veya süresi dolmuş olabilir.'
          : null;

  return (
    <main className="auth-page">
      <form className="auth-card" action={submitAdminInviteAction}>
        <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <h1 className="auth-title">Şifre belirleyin</h1>
        <p className="muted">
          Merhaba {displayName}, TakTic admin panel hesabınız için şifre belirleyin.
        </p>

        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#475569', marginTop: 12 }}>
          {user.email ? <div>E-posta: {user.email}</div> : null}
          <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>
            Bağlantı son geçerlilik: {formatExpiry(expiresAt)}
          </div>
        </div>

        {fieldError ? (
          <div className="error-message" role="alert" style={{ marginTop: 12 }}>
            {fieldError}
          </div>
        ) : null}

        <input type="hidden" name="token" value={token} />

        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <label className="form-row">
            <span>Yeni şifre</span>
            <input
              name="password"
              type="password"
              minLength={8}
              maxLength={128}
              required
              autoComplete="new-password"
              placeholder="En az 8 karakter"
            />
          </label>
          <label className="form-row">
            <span>Şifre tekrarı</span>
            <input
              name="passwordConfirm"
              type="password"
              minLength={8}
              maxLength={128}
              required
              autoComplete="new-password"
            />
          </label>
          <button className="btn btn-primary btn-block" type="submit">
            Şifreyi Kaydet
          </button>
        </div>

        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
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

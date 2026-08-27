import { cookies } from 'next/headers';
import Link from 'next/link';
import { CLAIM_TOKEN_COOKIE, isProviderClaimEnabled } from '../../lib/provider-claim';
import { PasswordFields } from '../password-criteria';
import { startClaimLoginAction, submitProviderClaimAction } from './actions';

const apiUrl =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type SearchParams = {
  token?: string;
  error?: string;
};

type ClaimPageProps = {
  searchParams: Promise<SearchParams>;
};

type ClaimOutcome = 'NEW_ACCOUNT' | 'LINK_EXISTING_PROVIDER' | 'LOGIN_REQUIRED';

type ValidateSuccess = {
  valid: true;
  outcome: ClaimOutcome;
  /** The only form of the address this screen ever receives. */
  maskedEmail: string;
  expiresAt: string;
  application: {
    businessName: string;
    city: string;
    district: string;
    status: string;
  };
};

type ValidateResult =
  | { kind: 'ok'; payload: ValidateSuccess }
  | { kind: 'error'; message: string };

const FALLBACK_MESSAGE = 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir bağlantı isteyin.';

async function validateClaimToken(token: string): Promise<ValidateResult> {
  try {
    const cookieHeader = (await cookies()).toString();
    const response = await fetch(
      `${apiUrl}/auth/provider-claim?token=${encodeURIComponent(token)}`,
      {
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      },
    );

    if (!response.ok) {
      return { kind: 'error', message: (await safeReadMessage(response)) ?? FALLBACK_MESSAGE };
    }

    return { kind: 'ok', payload: (await response.json()) as ValidateSuccess };
  } catch {
    return { kind: 'error', message: 'Bağlantı doğrulanamadı. Lütfen tekrar deneyin.' };
  }
}

/**
 * The screen that turns a mailed link into ownership of an application.
 *
 * The token reaches it once, in the query string of the link the applicant
 * received, and never leaves this page in a URL again: the actions move it into
 * an httpOnly cookie, which is also where it is read from after a detour
 * through the login screen. Nothing here renders the token, and no error path
 * puts it — or the applicant's address — back into a URL.
 */
export default async function ClaimProviderPage({ searchParams }: ClaimPageProps) {
  const { token: tokenFromLink, error } = await searchParams;

  if (!isProviderClaimEnabled()) {
    return (
      <ClaimShell title="Bu özellik şu anda kapalı">
        <p className="muted">
          Başvuru sahiplenme şu anda kullanılamıyor. Yardım için ekibimizle iletişime geçin.
        </p>
      </ClaimShell>
    );
  }

  const token = tokenFromLink?.trim() || (await cookies()).get(CLAIM_TOKEN_COOKIE)?.value || '';

  if (!token) {
    return (
      <ClaimShell title="Bağlantı bulunamadı">
        <p className="muted">{FALLBACK_MESSAGE}</p>
        <Link className="btn btn-ghost" href="/">
          Ana sayfa
        </Link>
      </ClaimShell>
    );
  }

  const result = await validateClaimToken(token);

  if (result.kind === 'error') {
    return (
      <ClaimShell title="Bağlantı kullanılamıyor">
        <p className="muted">{result.message}</p>
        <Link className="btn btn-ghost" href="/">
          Ana sayfa
        </Link>
      </ClaimShell>
    );
  }

  const { outcome, maskedEmail, application } = result.payload;

  return (
    <ClaimShell title="Başvurunuzu hesabınıza bağlayın">
      <dl className="pdash-info-grid" style={{ marginBottom: 18 }}>
        <div className="pdash-info-row">
          <dt>İşletme</dt>
          <dd>{application.businessName}</dd>
        </div>
        <div className="pdash-info-row">
          <dt>Konum</dt>
          <dd>
            {application.city}/{application.district}
          </dd>
        </div>
        <div className="pdash-info-row">
          <dt>E-posta</dt>
          <dd>{maskedEmail}</dd>
        </div>
      </dl>

      {error === 'password' ? (
        <div className="auth-screen-error" role="alert">
          Şifre en az 8 karakter olmalı.
        </div>
      ) : null}
      {error === 'mismatch' ? (
        <div className="auth-screen-error" role="alert">
          Şifreler eşleşmiyor.
        </div>
      ) : null}

      {outcome === 'LOGIN_REQUIRED' ? (
        <>
          <p className="muted">
            Bu e-posta adresiyle bir hizmet veren hesabı zaten var. Devam etmek için giriş yapın;
            girişten sonra bu adım kaldığı yerden sürer.
          </p>
          <form action={startClaimLoginAction}>
            <input type="hidden" name="token" value={token} />
            <button className="btn btn-primary" type="submit">
              Giriş yap ve devam et
            </button>
          </form>
        </>
      ) : null}

      {outcome === 'LINK_EXISTING_PROVIDER' ? (
        <>
          <p className="muted">
            Bu başvuru, giriş yapmış olduğunuz hizmet veren hesabına bağlanacak.
          </p>
          <form action={submitProviderClaimAction}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="needsPassword" value="false" />
            <button className="btn btn-primary" type="submit">
              Başvuruyu hesabıma bağla
            </button>
          </form>
        </>
      ) : null}

      {outcome === 'NEW_ACCOUNT' ? (
        <>
          <p className="muted">
            Hizmet veren hesabınızı oluşturmak için bir şifre belirleyin. Hesabınız bu e-posta
            adresiyle açılacak.
          </p>
          <form action={submitProviderClaimAction} className="auth-screen-fields">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="needsPassword" value="true" />
            <PasswordFields
              labels={{ password: 'Şifre *', confirm: 'Şifre (tekrar) *' }}
            />
            <button className="btn btn-primary" type="submit">
              Hesabı oluştur ve başvuruyu bağla
            </button>
          </form>
        </>
      ) : null}
    </ClaimShell>
  );
}

function ClaimShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main>
      <div className="page-narrow">
        <section className="card" style={{ margin: 0, padding: 32 }}>
          <h1 className="page-title" style={{ marginTop: 0 }}>
            {title}
          </h1>
          {children}
        </section>
      </div>
    </main>
  );
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
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

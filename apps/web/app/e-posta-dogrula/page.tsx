import Link from 'next/link';
import { AuthFrame } from '../auth-frame';
import { apiUrl, readApiMessage } from '../api-base';

type VerifyEmailPageProps = {
  searchParams: Promise<{ token?: string }>;
};

type ConfirmResult =
  | { kind: 'ok'; alreadyVerified: boolean }
  | { kind: 'error'; message: string };

/**
 * Confirms on load, rather than behind a button.
 *
 * The link is single use and arrives from an inbox; asking the reader to press
 * something first adds a step without adding a guarantee. There is no session
 * requirement either — the token is the proof, and the mail is often opened in
 * a browser the customer never signed in with.
 */
async function confirmVerification(token: string): Promise<ConfirmResult> {
  try {
    const response = await fetch(`${apiUrl}/auth/email-verification/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      cache: 'no-store',
    });

    if (!response.ok) {
      const message = await readApiMessage(response);
      return { kind: 'error', message: message ?? 'Bağlantı geçersiz veya süresi dolmuş.' };
    }

    const payload = (await response.json()) as { alreadyVerified?: boolean };
    return { kind: 'ok', alreadyVerified: payload.alreadyVerified === true };
  } catch {
    return { kind: 'error', message: 'Doğrulama tamamlanamadı. Lütfen tekrar deneyin.' };
  }
}

export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const { token } = await searchParams;
  const trimmed = token?.trim();

  const result = trimmed
    ? await confirmVerification(trimmed)
    : ({ kind: 'error', message: 'Doğrulama bağlantısı bulunamadı.' } as const);

  if (result.kind === 'error') {
    return (
      <AuthFrame tab="login">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h1 className="auth-screen-title">Bağlantı geçersiz</h1>
          <p className="auth-screen-subtitle">{result.message}</p>
          <Link className="auth-screen-submit" href="/login" style={{ textAlign: 'center' }}>
            Giriş ekranına dön
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame tab="login">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 className="auth-screen-title">
          {result.alreadyVerified ? 'E-postanız zaten doğrulanmış' : 'E-postanız doğrulandı'}
        </h1>
        <p className="auth-screen-subtitle">
          {result.alreadyVerified
            ? 'Bu adres için doğrulama kaydı zaten vardı. Yapmanız gereken başka bir şey yok.'
            : 'Teşekkür ederiz. Hesabınızı kullanmaya devam edebilirsiniz.'}
        </p>
        <Link className="auth-screen-submit" href="/requests/my" style={{ textAlign: 'center' }}>
          Taleplerime Git
        </Link>
      </div>
    </AuthFrame>
  );
}

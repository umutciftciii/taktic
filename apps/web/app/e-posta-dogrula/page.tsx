import Link from 'next/link';
import { getCurrentUser } from '../../lib/api';
import { AuthFrame } from '../auth-frame';
import {
  readVerificationLink,
  resultFromSearchParams,
  type VerificationState,
  type VerifiedAccountKind,
} from './verify';

type VerifyEmailPageProps = {
  searchParams: Promise<{ token?: string; sonuc?: string; hesap?: string }>;
};

/**
 * Reads the link and asks for a click; never spends it on load.
 *
 * Opening this page used to confirm the link, and a mail scanner opening it
 * first was enough to spend it (STAGING-UAT-001 B3). Now the page only reads
 * the link; the button posts it to `/e-posta-dogrula/submit`, which spends it
 * and comes back here with a result word (`?sonuc=`) instead of the token.
 * See ./verify.ts.
 */
export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const params = await searchParams;
  const token = params.token?.trim();

  const state: VerificationState =
    resultFromSearchParams(params) ?? (token ? await readVerificationLink(token) : { kind: 'invalid' });
  const user = await getCurrentUser();

  return (
    <AuthFrame tab="login" showTabs={!user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <VerificationScreen state={state} token={token} signedIn={user !== null} />
      </div>
    </AuthFrame>
  );
}

function VerificationScreen({
  state,
  token,
  signedIn,
}: {
  state: VerificationState;
  token: string | undefined;
  signedIn: boolean;
}) {
  switch (state.kind) {
    case 'ready':
      return (
        <>
          <h1 className="auth-screen-title">E-postanızı doğrulayın</h1>
          <p className="auth-screen-subtitle">
            Bu adresin size ait olduğunu doğrulamak için aşağıdaki butona basın.
          </p>
          <form method="post" action="/e-posta-dogrula/submit">
            <input type="hidden" name="token" value={token ?? ''} />
            <button type="submit" className="auth-screen-submit">
              E-postamı doğrula
            </button>
          </form>
        </>
      );
    case 'verified':
      return (
        <>
          <h1 className="auth-screen-title">E-postanız doğrulandı</h1>
          <p className="auth-screen-subtitle">Teşekkür ederiz. Hesabınızı kullanmaya devam edebilirsiniz.</p>
          <PanelLink accountKind={state.accountKind} />
        </>
      );
    case 'already':
      return (
        <>
          <h1 className="auth-screen-title">E-postanız zaten doğrulanmış</h1>
          <p className="auth-screen-subtitle">
            Bu bağlantı daha önce kullanıldı ve adresiniz doğrulandı. Yapmanız gereken başka bir şey yok.
          </p>
          <PanelLink accountKind={state.accountKind} />
        </>
      );
    case 'expired':
      return (
        <>
          <h1 className="auth-screen-title">Bağlantının süresi dolmuş</h1>
          <p className="auth-screen-subtitle">
            {state.accountKind === 'PROVIDER'
              ? 'Panelinizdeki “Hesap iletişimi” kartından yeni bir doğrulama bağlantısı isteyebilirsiniz.'
              : 'Doğrulama hesabınızın kullanımını kısıtlamaz; talep oluşturmaya ve teklifleri görmeye devam edebilirsiniz.'}
          </p>
          <PanelLink accountKind={state.accountKind} />
        </>
      );
    case 'failed':
      return (
        <>
          <h1 className="auth-screen-title">Doğrulama tamamlanamadı</h1>
          <p className="auth-screen-subtitle">
            Şu anda işleminizi tamamlayamadık. Bağlantıyı e-postanızdan yeniden açıp tekrar deneyin.
          </p>
          <HomeLink signedIn={signedIn} />
        </>
      );
    case 'invalid':
      return (
        <>
          <h1 className="auth-screen-title">Bağlantı geçersiz</h1>
          <p className="auth-screen-subtitle">
            Bu doğrulama bağlantısı geçerli değil. Size en son gönderilen e-postadaki bağlantıyı kullanın.
          </p>
          <HomeLink signedIn={signedIn} />
        </>
      );
  }
}

function PanelLink({ accountKind }: { accountKind: VerifiedAccountKind }) {
  // Which panel to send the reader on to. A provider's mailbox is proven by the
  // same link as a customer's (AUTH-PROVIDER-CONTACT-001); only where they go
  // next differs.
  return accountKind === 'PROVIDER' ? (
    <Link className="auth-screen-submit" href="/providers/me" style={{ textAlign: 'center' }}>
      Panelime Git
    </Link>
  ) : (
    <Link className="auth-screen-submit" href="/requests/my" style={{ textAlign: 'center' }}>
      Taleplerime Git
    </Link>
  );
}

function HomeLink({ signedIn }: { signedIn: boolean }) {
  return signedIn ? (
    <Link className="auth-screen-submit" href="/" style={{ textAlign: 'center' }}>
      Ana sayfaya dön
    </Link>
  ) : (
    <Link className="auth-screen-submit" href="/login" style={{ textAlign: 'center' }}>
      Giriş ekranına dön
    </Link>
  );
}

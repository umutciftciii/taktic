import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAccountProfile, getCurrentUser } from '../../../lib/api';
import { PASSWORD_MIN_LENGTH } from '../../../lib/password-policy';
import { PasswordFields } from '../../password-criteria';
import { CustomerShell } from '../../requests/customer-shell';
import { changePasswordAction } from '../actions';

/**
 * What each refusal means, in the customer's own language.
 *
 * The action sends a code and this owns the sentence, so nothing that was typed
 * — no fragment of either password — can travel in a URL. None of these says
 * anything about the account itself either: "the current password did not
 * match" is the whole of what a wrong first field is told.
 */
const ERROR_MESSAGES: Record<string, string> = {
  current: 'Mevcut şifreniz doğrulanamadı. Lütfen tekrar deneyin.',
  policy: `Yeni şifreniz en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`,
  mismatch: 'Yeni şifre ile tekrarı aynı değil.',
  same: 'Yeni şifreniz mevcut şifrenizden farklı olmalı.',
  nopassword:
    'Hesabınızda henüz bir şifre tanımlı değil. Şifrenizi etkinleştirme bağlantısıyla belirleyin.',
  throttled: 'Çok fazla deneme yapıldı. Lütfen bir dakika sonra tekrar deneyin.',
  submit: 'Şifreniz değiştirilemedi. Lütfen daha sonra tekrar deneyin.',
};

type AccountPasswordPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AccountPasswordPage({ searchParams }: AccountPasswordPageProps) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?redirectTo=/account/password');
  }
  if (user.role !== 'CUSTOMER') {
    redirect('/');
  }

  const profile = await getAccountProfile();
  const params = await searchParams;
  const success = readParam(params, 'success') === '1';
  const errorCode = readParam(params, 'error');
  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.submit) : null;

  // An account created for a guest service request has no password until the
  // activation link is followed. It cannot be *changed*, so the screen sends
  // that person to the flow that sets one instead of to a form whose first
  // field they have nothing to put in. A profile that could not be loaded is
  // treated as an ordinary one: the API refuses the change either way, and
  // hiding the form over a network hiccup would be the worse mistake.
  const hasPassword = profile ? profile.hasPassword : true;

  return (
    <CustomerShell user={user} active="settings">
      <header className="cdash-page-head">
        <span className="kicker">Hesap</span>
        <h1 className="cdash-page-title">Şifre değiştir</h1>
        <p className="cdash-page-sub">
          Mevcut şifrenizi doğrulayarak yeni bir şifre belirleyin.
        </p>
      </header>

      <div className="split">
        <div className="split-main">
          {success ? (
            <div className="notice" role="status" data-testid="account-password-success">
              <span>
                Şifreniz güncellendi. Bu tarayıcıdaki oturumunuz açık kaldı; diğer cihazlardaki
                oturumlar kapatıldı.
              </span>
            </div>
          ) : null}

          {errorMessage ? (
            <div
              className="notice cdash-notice-error"
              role="alert"
              data-testid="account-password-error"
            >
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {hasPassword ? (
            <section className="cdash-detail-card" aria-labelledby="account-password-heading">
              <h2 id="account-password-heading">Şifreniz</h2>

              <form action={changePasswordAction} className="cdash-account-form">
                <label className="field">
                  <span className="field-label">Mevcut şifre</span>
                  <input
                    className="field-control"
                    name="currentPassword"
                    type="password"
                    required
                    // The browser and the password manager both need to be told
                    // which of the three fields is which, or they offer the
                    // saved password where the new one belongs.
                    autoComplete="current-password"
                  />
                </label>

                {/*
                  The same component the activation and reset screens use, so
                  the criteria a customer is shown here are a reading of the one
                  policy the API enforces rather than a second opinion about it.
                  It posts `password` and `passwordConfirm`, both marked
                  `new-password`, and ticks the match criterion as they type.
                */}
                <PasswordFields
                  labels={{ password: 'Yeni şifre', confirm: 'Yeni şifre (tekrar)' }}
                  classNames={{ field: 'field', label: 'field-label', input: 'field-control' }}
                />

                <div className="inline-actions">
                  <button className="cdash-btn cdash-btn-primary" type="submit">
                    Şifreyi güncelle
                  </button>
                  <Link className="cdash-btn cdash-btn-secondary" href="/account/profile">
                    Profil bilgilerine dön
                  </Link>
                </div>
              </form>
            </section>
          ) : (
            <section className="cdash-detail-card" aria-labelledby="account-activation-heading">
              <h2 id="account-activation-heading">Önce şifrenizi belirleyin</h2>
              <p className="cdash-page-sub" style={{ margin: 0 }}>
                Hesabınız bir talep üzerinden oluşturulmuş ve henüz bir şifresi yok. Bu yüzden
                değiştirilecek bir şifre de bulunmuyor. E-postanıza gönderilen etkinleştirme
                bağlantısıyla şifrenizi belirleyebilirsiniz; bağlantı elinizde değilse kayıt
                ekranından e-posta adresinizi girerek yenisini isteyebilirsiniz.
              </p>
              <div className="inline-actions">
                <Link className="cdash-btn cdash-btn-primary" href="/register/customer">
                  Etkinleştirme bağlantısı iste
                </Link>
                <Link className="cdash-btn cdash-btn-secondary" href="/account/profile">
                  Profil bilgilerine dön
                </Link>
              </div>
            </section>
          )}
        </div>

        <aside className="split-rail" aria-label="Güvenlik notu">
          <div className="rail-note">
            <strong>Diğer oturumlar.</strong> Şifreniz değiştiğinde bu tarayıcıdaki oturumunuz
            açık kalır, hesabınızın açık olduğu diğer cihazlar ise yeniden giriş yapmak zorunda
            kalır.
          </div>
          <div className="rail-note">
            <strong>Şifrenizi hatırlamıyorsanız.</strong> Giriş ekranındaki “Şifremi unuttum”
            bağlantısıyla e-posta adresinize sıfırlama bağlantısı isteyebilirsiniz.
          </div>
        </aside>
      </div>
    </CustomerShell>
  );
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

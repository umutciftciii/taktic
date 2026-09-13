'use client';

import type { IdentityStatus } from './identity-check';

type Props = {
  status: IdentityStatus;
  onRetry: () => void;
  onLogin: () => void | Promise<void>;
  onActivate: () => void | Promise<void>;
  activationSent: boolean;
  draftError: 'DRAFT_BUSY' | 'DRAFT_FAILED' | null;
  draftExists: boolean;
  onReplaceDraft: () => void;
  onKeepDraft: () => void;
  wrongAccount: boolean;
  changeAccountHref: string;
  busy: boolean;
};

export function IdentityNotice(p: Props) {
  if (p.wrongAccount) {
    return (
      <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-wrong-account">
        <span>Bu talebe devam etmek için iletişim bilgilerine bağlı hesabınızla giriş yapın.</span>
        <a className="btn btn-secondary" href={p.changeAccountHref}>Hesap değiştir</a>
      </div>
    );
  }
  if (p.draftExists) {
    return (
      <div className="notice identity-notice" role="alertdialog" data-testid="identity-draft-exists">
        <span>Yeni taslağa geçerseniz önceki taslak silinir. Devam edilsin mi?</span>
        <div className="inline-actions">
          <button type="button" className="btn btn-primary" onClick={p.onReplaceDraft} disabled={p.busy}>Evet, geç</button>
          <button type="button" className="btn btn-secondary" onClick={p.onKeepDraft} disabled={p.busy}>Vazgeç</button>
        </div>
      </div>
    );
  }
  if (p.draftError) {
    return (
      <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-draft-error">
        <span>Taslak şu anda kaydedilemedi. Birkaç dakika sonra tekrar deneyin.</span>
        <button type="button" className="btn btn-secondary" onClick={p.onRetry} disabled={p.busy}>Tekrar dene</button>
      </div>
    );
  }
  switch (p.status) {
    case 'checking':
      return <p className="help-text" role="status" data-testid="identity-checking">İletişim bilgileriniz kontrol ediliyor…</p>;
    case 'identity-conflict':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-conflict">
          Bu telefon numarası ve e-posta iki farklı müşteri hesabına bağlı. Tek bir hesaba ait iletişim bilgileriyle devam edin.
        </div>
      );
    case 'login-required':
      return (
        <div className="notice identity-notice" role="alert" data-testid="identity-login-required">
          <span>Bu iletişim bilgileriyle bir hesabınız var. Talebinizi hesabınızla devam ettirmek için giriş yapın.</span>
          <button type="button" className="btn btn-primary" onClick={() => void p.onLogin()} disabled={p.busy} data-testid="identity-login-cta">Giriş yap</button>
        </div>
      );
    case 'activation-required':
      return (
        <div className="notice identity-notice" role="alert" data-testid="identity-activation-required">
          {p.activationSent ? (
            <span data-testid="identity-activation-sent">Bağlantıyı hesabınıza kayıtlı e-posta adresine gönderdik. Şifrenizi belirlediğinizde kaldığınız yerden devam edeceksiniz.</span>
          ) : (
            <>
              <span>Bu bilgilerle daha önce oluşturulmuş hesabınızı etkinleştirin.</span>
              <button type="button" className="btn btn-primary" onClick={() => void p.onActivate()} disabled={p.busy} data-testid="identity-activate-cta">Etkinleştirme bağlantısı gönder</button>
            </>
          )}
        </div>
      );
    case 'unavailable':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-unavailable">
          Bu iletişim bilgileri müşteri talebi için kullanılamaz. Farklı bir telefon numarası veya e-posta girin.
        </div>
      );
    case 'error':
      return (
        <div className="notice cdash-notice-error identity-notice" role="alert" data-testid="identity-error">
          <span>İletişim bilgileri doğrulanamadı, tekrar deneyin.</span>
          <button type="button" className="btn btn-secondary" onClick={p.onRetry} disabled={p.busy}>Tekrar dene</button>
        </div>
      );
    default:
      return null;
  }
}

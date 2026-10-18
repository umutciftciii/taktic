import Link from 'next/link';
import { BrandMark } from '../../components/brand-mark';

type ForgotPasswordPageProps = {
  searchParams: Promise<{ sent?: string }>;
};

/**
 * ADMIN-AUTH-001: asking for a reset link from the panel's own sign-in card.
 *
 * The link itself is sent by the same API flow the marketplace uses; a staff
 * account's link lands on this app's /sifre-sifirla.
 */
export default async function AdminForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const { sent } = await searchParams;

  if (sent === '1') {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark size="lg" />
            <div className="auth-brand-text">
              <h1 className="auth-title">Bağlantı gönderildi</h1>
              <p className="auth-subtitle">E-posta kutunuzu kontrol edin</p>
            </div>
          </div>
          {/*
            Worded so it is true either way. The API never says whether an
            address is registered, and neither may this screen.
          */}
          <p className="muted" role="status">
            Girdiğiniz adres yönetim paneline erişimi olan bir hesaba aitse şifre sıfırlama
            bağlantısını gönderdik. Bağlantı 30 dakika boyunca geçerlidir ve yalnızca bir kez
            kullanılabilir.
          </p>
          <Link className="btn btn-primary btn-block" href="/login" style={{ marginTop: 16 }}>
            Giriş ekranına dön
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <form className="auth-card" action="/sifre-unuttum/submit" method="post">
        <div className="auth-brand">
          <BrandMark size="lg" />
          <div className="auth-brand-text">
            <h1 className="auth-title">Şifrenizi mi unuttunuz?</h1>
            <p className="auth-subtitle">TakTick Yönetim</p>
          </div>
        </div>
        <p className="muted">
          Yönetim paneli hesabınızın e-posta adresini girin; şifrenizi yeniden belirlemeniz için
          bir bağlantı gönderelim.
        </p>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <label className="form-row">
            <span>E-posta</span>
            <input name="email" type="email" required autoComplete="email" maxLength={254} />
          </label>
          <button className="btn btn-primary btn-block" type="submit">
            Sıfırlama Bağlantısı Gönder
          </button>
        </div>
        <p className="auth-footnote">
          Şifrenizi hatırladınız mı?{' '}
          <Link href="/login" style={{ textDecoration: 'underline' }}>
            Giriş yapın
          </Link>
          .
        </p>
      </form>
    </main>
  );
}

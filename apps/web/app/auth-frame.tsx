import Link from 'next/link';
import type { ReactNode } from 'react';

const POSTER_POINTS = [
  'Taleplerinin durumunu tek ekrandan izle',
  'Gelen teklifleri yan yana karşılaştır',
  'Kabul ettiğin ustayla iletişime geç',
];

type AuthFrameProps = {
  /** Which of the two tabs is the current screen. */
  tab: 'login' | 'register';
  /** Where the register tab should go — customer and provider sign-up differ. */
  registerHref?: string;
  loginHref?: string;
  children: ReactNode;
};

/**
 * The shared sign-in / sign-up frame: an accent poster on the left, the form on
 * the right under a two-tab switch.
 *
 * The tabs are links, not client state, because the two sides are separate
 * routes with their own server actions — swapping them in place would break the
 * redirect contract each action relies on.
 */
export function AuthFrame({
  tab,
  registerHref = '/register/customer',
  loginHref = '/login',
  children,
}: AuthFrameProps) {
  return (
    <main className="auth-screen">
      <section className="auth-poster">
        <span className="kicker">TakTick hesabı</span>
        <h2 className="auth-poster-title">Talepler, teklifler ve eşleşmeler tek yerde.</h2>
        <p className="auth-poster-sub">
          Bir hesapla talep aç, gelen teklifleri karşılaştır, kabul ettiğin ustayla iletişime geç.
        </p>
        <ul className="auth-poster-list">
          {POSTER_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="auth-form-side">
        <div className="auth-screen-card">
          <div className="auth-tabs" role="tablist" aria-label="Hesap">
            <Link
              className={`auth-tab${tab === 'login' ? ' is-active' : ''}`}
              href={loginHref}
              role="tab"
              aria-selected={tab === 'login'}
            >
              Giriş yap
            </Link>
            <Link
              className={`auth-tab${tab === 'register' ? ' is-active' : ''}`}
              href={registerHref}
              role="tab"
              aria-selected={tab === 'register'}
            >
              Hesap oluştur
            </Link>
          </div>

          {children}
        </div>
      </section>
    </main>
  );
}

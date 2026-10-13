import Link from 'next/link';
import type { AuthUser } from '../lib/api';
import { IconChevronDown } from './landing-icons';
import { SiteMenu } from './site-menu';
import { StartChoiceModal } from './start-choice-modal';

type SiteHeaderProps = {
  user: AuthUser | null;
  providerId: string | null;
};

/**
 * One row on every width.
 *
 * Desktop: logo, links, account actions — unchanged. Below 900px the links fold
 * behind `SiteMenu`'s toggle instead of wrapping the header into three rows,
 * and the account action that matters for who is looking stays in the bar: the
 * request CTA for a visitor, the account menu for anyone signed in. A visitor's
 * "Giriş" moves into the menu below 640px, where the bar has room for one
 * button beside the logo and the toggle (see globals.css, "Public shell").
 *
 * A staff account has no public links at all, so it gets no toggle either — a
 * button that opens an empty panel is worse than none.
 */
export function SiteHeader({ user, providerId }: SiteHeaderProps) {
  const hasNav = !user || user.role === 'CUSTOMER' || user.role === 'PROVIDER';

  return (
    <header className="lp-header" id="site-header">
      <div className="lp-container lp-header-inner">
        <Link className="lp-logo" href="/" aria-label="TakTick ana sayfa">
          <img className="brand-logo" src="/brand/logo.png" alt="TakTick" />
        </Link>

        {hasNav ? (
          <SiteMenu>
            <HeaderNav user={user} providerId={providerId} />
            {!user ? (
              <Link className="btn btn-secondary lp-menu-signin" href="/login">
                Giriş yap
              </Link>
            ) : null}
          </SiteMenu>
        ) : (
          <HeaderNav user={user} providerId={providerId} />
        )}
        <HeaderCta user={user} />
      </div>
    </header>
  );
}

function HeaderNav({ user, providerId }: SiteHeaderProps) {
  if (!user) {
    return (
      <nav className="lp-nav" aria-label="Site navigation">
        <Link href="/categories">Kategoriler</Link>
        <Link href="/#nasil-calisir">Nasıl çalışır</Link>
        <Link href="/providers/register">Hizmet veren ol</Link>
        <Link href="/#lp-sss">Yardım</Link>
      </nav>
    );
  }

  if (user.role === 'CUSTOMER') {
    return (
      <nav className="lp-nav" aria-label="Site navigation">
        <Link href="/categories">Kategoriler</Link>
        <Link href="/requests/my">Taleplerim</Link>
        <Link href="/#lp-sss">Yardım</Link>
      </nav>
    );
  }

  if (user.role === 'PROVIDER') {
    return (
      <nav className="lp-nav" aria-label="Site navigation">
        <Link href="/providers/me">Panelim</Link>
        {providerId ? <Link href={`/providers/${providerId}/requests`}>Uygun talepler</Link> : null}
        {providerId ? <Link href={`/providers/${providerId}/offers`}>Tekliflerim</Link> : null}
      </nav>
    );
  }

  return <nav className="lp-nav" aria-label="Site navigation" />;
}

function HeaderCta({ user }: { user: AuthUser | null }) {
  if (!user) {
    return (
      <div className="lp-header-cta">
        <Link className="btn btn-secondary lp-header-signin" href="/login">
          Giriş
        </Link>
        <StartChoiceModal user={user} label="Talep Oluştur" className="btn btn-primary" />
      </div>
    );
  }

  return (
    <div className="lp-header-cta">
      {user.role === 'CUSTOMER' ? (
        <Link className="btn btn-primary lp-cta-mobile-hide" href="/categories">
          Talep Oluştur
        </Link>
      ) : null}
      <UserMenu user={user} />
    </div>
  );
}

function UserMenu({ user }: { user: AuthUser }) {
  const display = displayName(user);
  const initials = getInitials(display);

  return (
    <details className="lp-user">
      <summary className="lp-user-summary" aria-label="Kullanıcı menüsü">
        <span className="lp-user-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="lp-user-name">{display}</span>
        <span className="lp-user-caret">
          <IconChevronDown size={12} />
        </span>
      </summary>
      <div className="lp-user-menu" role="menu">
        <div className="lp-user-info">
          <div className="lp-user-info-name">{display}</div>
          {user.email ? <div className="lp-user-info-meta">{user.email}</div> : null}
          <div className="lp-user-info-role">{roleLabel(user.role)}</div>
        </div>
        <div className="lp-user-divider" />
        {user.role === 'CUSTOMER' ? (
          <Link className="lp-user-link" href="/requests/my" role="menuitem">
            Taleplerim
          </Link>
        ) : null}
        {user.role === 'PROVIDER' ? (
          <Link className="lp-user-link" href="/providers/me" role="menuitem">
            Profilim
          </Link>
        ) : null}
        <form action="/logout" method="post">
          <button type="submit" className="lp-user-link lp-user-logout" role="menuitem">
            Çıkış yap
          </button>
        </form>
      </div>
    </details>
  );
}

function displayName(user: AuthUser): string {
  return (
    (user.name && user.name.trim()) ||
    user.email ||
    user.phone ||
    'Hesabım'
  );
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'T';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'T';
}

function roleLabel(role: AuthUser['role']): string {
  switch (role) {
    case 'CUSTOMER':
      return 'Müşteri';
    case 'PROVIDER':
      return 'Hizmet veren';
    // Both staff kinds read as "Yönetici" here. The marketplace header has no
    // business distinguishing a super admin from a staff account with roles —
    // that difference lives in the admin panel and nowhere else.
    case 'SUPER_ADMIN':
    case 'ADMIN':
      return 'Yönetici';
    default:
      return '';
  }
}

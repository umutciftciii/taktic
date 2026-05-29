import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuthUser } from '../../lib/api';
import { providerDashboardLogoutAction } from '../login/actions';

type ProviderShellActive = 'dashboard' | 'requests' | 'offers' | 'credits' | 'profile';

type ProviderShellProps = {
  user: AuthUser;
  providerId?: string | null;
  businessName?: string | null;
  active?: ProviderShellActive;
  children: ReactNode;
};

export function ProviderShell({
  user,
  providerId,
  businessName,
  active = 'dashboard',
  children,
}: ProviderShellProps) {
  const display = displayName(user);
  const initials = getInitials(businessName ?? display);
  const subtitle = (businessName && businessName.trim()) || 'Hizmet Veren';
  const requestsHref = providerId ? `/providers/${providerId}/requests` : '/providers/me';
  const offersHref = providerId ? `/providers/${providerId}/offers` : null;
  const creditsHref = providerId ? `/providers/${providerId}/credits` : null;
  const profileHref = providerId ? `/providers/${providerId}` : null;

  const navItems: ReadonlyArray<{
    key: ProviderShellActive;
    label: string;
    icon: string;
    href: string | null;
  }> = [
    { key: 'dashboard', label: 'Panelim', icon: '▦', href: '/providers/me' },
    { key: 'requests', label: 'Uygun Talepler', icon: '🧭', href: requestsHref },
    { key: 'offers', label: 'Tekliflerim', icon: '📨', href: offersHref },
    { key: 'credits', label: 'Kredilerim', icon: '🪙', href: creditsHref },
    { key: 'profile', label: 'Profilim', icon: '👤', href: profileHref },
  ];

  return (
    <div className="pdash-shell">
      <aside className="pdash-sidebar" aria-label="Hizmet Veren Paneli navigasyonu">
        <div className="pdash-brand">
          <span className="pdash-brand-mark" aria-hidden="true">
            {initials || 'H'}
          </span>
          <div>
            <div className="pdash-brand-title">Hizmet Veren Paneli</div>
            <div className="pdash-brand-sub">{subtitle}</div>
          </div>
        </div>

        <Link className="pdash-cta" href={requestsHref}>
          <span className="pdash-cta-icon" aria-hidden="true">
            →
          </span>
          <span>Uygun Talepleri Gör</span>
        </Link>

        <nav className="pdash-nav" aria-label="Bölüm navigasyonu">
          {navItems.map((item) => {
            const isActive = item.key === active;

            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`pdash-nav-item${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="pdash-nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            }

            return (
              <span
                key={item.key}
                className="pdash-nav-item is-disabled"
                aria-disabled="true"
                title="Yakında"
              >
                <span className="pdash-nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                <span className="pdash-nav-soon">Yakında</span>
              </span>
            );
          })}
        </nav>

        <div className="pdash-sidebar-footer">
          <span className="pdash-nav-item is-disabled" aria-disabled="true" title="Yakında">
            <span className="pdash-nav-icon" aria-hidden="true">
              ⓘ
            </span>
            <span>Destek</span>
            <span className="pdash-nav-soon">Yakında</span>
          </span>
        </div>
      </aside>

      <div className="pdash-main">
        <div className="pdash-topbar">
          <div className="pdash-topbar-search" role="search" aria-label="Genel arama (yakında)">
            <span aria-hidden="true">🔍</span>
            <input type="search" placeholder="Ara..." disabled aria-disabled="true" />
          </div>
          <div className="pdash-topbar-actions">
            <span
              className="pdash-icon-btn"
              role="button"
              aria-label="Bildirimler (yakında)"
              aria-disabled="true"
              title="Yakında"
            >
              🔔
            </span>
            <span
              className="pdash-icon-btn"
              role="button"
              aria-label="Yardım (yakında)"
              aria-disabled="true"
              title="Yakında"
            >
              ?
            </span>
            <ProviderUserMenu
              user={user}
              display={display}
              initials={initials || 'H'}
              creditsHref={creditsHref}
              profileHref={profileHref}
            />
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

type ProviderUserMenuProps = {
  user: AuthUser;
  display: string;
  initials: string;
  creditsHref: string | null;
  profileHref: string | null;
};

function ProviderUserMenu({ user, display, initials, creditsHref, profileHref }: ProviderUserMenuProps) {
  return (
    <details className="pdash-user">
      <summary className="pdash-user-summary" aria-label="Kullanıcı menüsü">
        <span className="pdash-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="pdash-user-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="pdash-user-menu" role="menu">
        <div className="pdash-user-info">
          <div className="pdash-user-info-name">{display}</div>
          {user.email ? <div className="pdash-user-info-meta">{user.email}</div> : null}
          <div className="pdash-user-info-role">Hizmet Veren</div>
        </div>
        <div className="pdash-user-divider" />
        {profileHref ? (
          <Link className="pdash-user-link" href={profileHref} role="menuitem">
            Profilim
          </Link>
        ) : (
          <Link className="pdash-user-link" href="/providers/me" role="menuitem">
            Profilim
          </Link>
        )}
        {creditsHref ? (
          <Link className="pdash-user-link" href={creditsHref} role="menuitem">
            Kredilerim
          </Link>
        ) : null}
        <form action={providerDashboardLogoutAction}>
          <button type="submit" className="pdash-user-link pdash-user-logout" role="menuitem">
            Çıkış Yap
          </button>
        </form>
      </div>
    </details>
  );
}

function displayName(user: AuthUser): string {
  return (user.name && user.name.trim()) || user.email || user.phone || 'Hizmet Veren';
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'H';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'H';
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuthUser } from '../../lib/api';
import { customerLogoutAction } from '../login/actions';

type CustomerShellProps = {
  user: AuthUser;
  active?: 'dashboard' | 'requests' | 'messages' | 'settings';
  children: ReactNode;
};

const NAV_ITEMS: ReadonlyArray<{
  key: NonNullable<CustomerShellProps['active']>;
  label: string;
  icon: string;
  href: string | null;
}> = [
  { key: 'dashboard', label: 'Dashboard', icon: '▦', href: null },
  { key: 'requests', label: 'Taleplerim', icon: '📋', href: '/requests/my' },
  { key: 'messages', label: 'Mesajlar', icon: '💬', href: null },
  { key: 'settings', label: 'Ayarlar', icon: '⚙', href: null },
];

export function CustomerShell({ user, active = 'requests', children }: CustomerShellProps) {
  const display = displayName(user);
  const initials = getInitials(display);

  return (
    <div className="cdash-shell">
      <aside className="cdash-sidebar" aria-label="Müşteri Paneli navigasyonu">
        <Link className="shell-brand-logo-link" href="/" aria-label="TakTick ana sayfa">
          <img className="shell-brand-logo" src="/brand/logo.png" alt="TakTick" />
        </Link>
        <div className="cdash-brand">
          <span className="cdash-brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <div className="cdash-brand-title">Müşteri Paneli</div>
            <div className="cdash-brand-sub">{display}</div>
          </div>
        </div>

        <Link className="cdash-cta" href="/categories">
          <span className="cdash-cta-plus" aria-hidden="true">
            +
          </span>
          <span>Yeni Talep Oluştur</span>
        </Link>

        <nav className="cdash-nav" aria-label="Bölüm navigasyonu">
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === active;
            const isLinkable = !!item.href;

            if (isLinkable) {
              return (
                <Link
                  key={item.key}
                  href={item.href!}
                  className={`cdash-nav-item${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="cdash-nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            }

            return (
              <span
                key={item.key}
                className="cdash-nav-item is-disabled"
                aria-disabled="true"
                title="Yakında"
              >
                <span className="cdash-nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                <span className="cdash-nav-soon">Yakında</span>
              </span>
            );
          })}
        </nav>

        <div className="cdash-sidebar-footer">
          <span className="cdash-nav-item is-disabled" aria-disabled="true" title="Yakında">
            <span className="cdash-nav-icon" aria-hidden="true">
              ⓘ
            </span>
            <span>Destek</span>
            <span className="cdash-nav-soon">Yakında</span>
          </span>
        </div>
      </aside>

      <div className="cdash-main">
        <div className="cdash-topbar">
          <div className="cdash-topbar-search" role="search" aria-label="Genel arama (yakında)">
            <span aria-hidden="true">🔍</span>
            <input type="search" placeholder="Ara..." disabled aria-disabled="true" />
          </div>
          <div className="cdash-topbar-actions">
            <span
              className="cdash-icon-btn"
              role="button"
              aria-label="Bildirimler (yakında)"
              aria-disabled="true"
              title="Yakında"
            >
              🔔
            </span>
            <span
              className="cdash-icon-btn"
              role="button"
              aria-label="Yardım (yakında)"
              aria-disabled="true"
              title="Yakında"
            >
              ?
            </span>
            <CustomerUserMenu user={user} display={display} initials={initials} />
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}

type CustomerUserMenuProps = {
  user: AuthUser;
  display: string;
  initials: string;
};

function CustomerUserMenu({ user, display, initials }: CustomerUserMenuProps) {
  return (
    <details className="cdash-user">
      <summary className="cdash-user-summary" aria-label="Kullanıcı menüsü">
        <span className="cdash-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="cdash-user-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="cdash-user-menu" role="menu">
        <div className="cdash-user-info">
          <div className="cdash-user-info-name">{display}</div>
          {user.email ? <div className="cdash-user-info-meta">{user.email}</div> : null}
          <div className="cdash-user-info-role">Müşteri</div>
        </div>
        <div className="cdash-user-divider" />
        <Link className="cdash-user-link" href="/account/profile" role="menuitem">
          Profil Bilgileri
        </Link>
        <Link className="cdash-user-link" href="/account/password" role="menuitem">
          Şifre Değiştir
        </Link>
        <form action={customerLogoutAction}>
          <button type="submit" className="cdash-user-link cdash-user-logout" role="menuitem">
            Çıkış Yap
          </button>
        </form>
      </div>
    </details>
  );
}

function displayName(user: AuthUser): string {
  return (user.name && user.name.trim()) || user.email || user.phone || 'Hesabım';
}

function getInitials(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!cleaned) return 'M';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase('tr-TR')).join('') || 'M';
}

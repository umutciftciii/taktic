import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AuthUser } from '../../lib/api';
import {
  IconBell,
  IconChevronDown,
  IconClipList,
  IconCompare,
  IconHelp,
  IconMessage,
  IconPlus,
  IconSearch,
  IconSettings,
  IconUsers,
} from '../landing-icons';
import { customerLogoutAction } from '../login/actions';

type CustomerShellProps = {
  user: AuthUser;
  active?: 'requests' | 'offers' | 'compare' | 'matches' | 'messages' | 'settings';
  /** Live counters, read from the caller's own API data. Never invented here. */
  counts?: Partial<Record<'requests' | 'offers' | 'matches', number>>;
  children: ReactNode;
};

export function CustomerShell({
  user,
  active = 'requests',
  counts = {},
  children,
}: CustomerShellProps) {
  const display = displayName(user);
  const initials = getInitials(display);

  const navItems: ReadonlyArray<{
    key: NonNullable<CustomerShellProps['active']>;
    label: string;
    Icon: typeof IconClipList;
    href: string | null;
    count?: number | undefined;
  }> = [
    {
      key: 'requests',
      label: 'Taleplerim',
      Icon: IconClipList,
      href: '/requests/my',
      count: counts.requests,
    },
    // Offers, comparison and matches all live on a request: the panel routes to
    // the list, which is where a request is chosen.
    { key: 'offers', label: 'Teklifler', Icon: IconCompare, href: '/requests/my', count: counts.offers },
    { key: 'matches', label: 'Eşleşmelerim', Icon: IconUsers, href: '/requests/my', count: counts.matches },
    { key: 'messages', label: 'Mesajlar', Icon: IconMessage, href: null },
    { key: 'settings', label: 'Profil ve ayarlar', Icon: IconSettings, href: '/account/profile' },
  ];

  return (
    <div className="cdash-shell">
      <aside className="cdash-sidebar" aria-label="Müşteri Paneli navigasyonu">
        <div className="cdash-brand">
          <Link href="/" aria-label="TakTick ana sayfa">
            <img className="brand-mark-img" style={{ height: 38 }} src="/brand/icon.png" alt="TakTick" />
          </Link>
          <div style={{ minWidth: 0 }}>
            <div className="cdash-brand-title">Hizmet Alan Paneli</div>
            <div className="cdash-brand-sub">{display}</div>
          </div>
        </div>

        <Link className="cdash-cta" href="/categories">
          <IconPlus size={14} />
          <span>Yeni Talep Oluştur</span>
        </Link>

        <nav className="cdash-nav" aria-label="Bölüm navigasyonu">
          {navItems.map((item) => {
            const isActive = item.key === active;
            const { Icon } = item;

            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`cdash-nav-item${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="cdash-nav-icon">
                    <Icon size={16} />
                  </span>
                  <span>{item.label}</span>
                  {typeof item.count === 'number' ? (
                    <span className="cdash-nav-count">{item.count}</span>
                  ) : null}
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
                <span className="cdash-nav-icon">
                  <Icon size={16} />
                </span>
                <span>{item.label}</span>
                <span className="cdash-nav-soon">Yakında</span>
              </span>
            );
          })}
        </nav>

        <div className="cdash-sidebar-footer">
          <span className="cdash-nav-item is-disabled" aria-disabled="true" title="Yakında">
            <span className="cdash-nav-icon">
              <IconHelp size={16} />
            </span>
            <span>Destek</span>
            <span className="cdash-nav-soon">Yakında</span>
          </span>
        </div>
      </aside>

      <div className="cdash-main">
        <div className="cdash-topbar">
          <div className="cdash-topbar-search" role="search" aria-label="Genel arama (yakında)">
            <IconSearch size={16} />
            <input type="search" placeholder="Talep, teklif veya işletme ara..." disabled aria-disabled="true" />
          </div>
          <div className="cdash-topbar-actions">
            <span
              className="cdash-icon-btn"
              role="button"
              aria-label="Bildirimler (yakında)"
              aria-disabled="true"
              title="Yakında"
            >
              <IconBell size={16} />
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
        <span className="lp-user-name">{display}</span>
        <span className="cdash-user-caret">
          <IconChevronDown size={12} />
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

import Link from 'next/link';
import type { ReactNode } from 'react';
import { loadUnreadMessageCount, type AuthUser, type ProviderStatus } from '../../lib/api';
import { statusLabel } from '../../lib/request-formatters';
import {
  IconBell,
  IconChevronDown,
  IconCoins,
  IconCompass,
  IconGrid,
  IconHelp,
  IconPackage,
  IconMessage,
  IconProfile,
  IconSearch,
  IconSend,
} from '../landing-icons';
import { PanelDrawer } from '../panel-drawer';
import { providerDashboardLogoutAction } from '../login/actions';
import { LogoutButton } from '../session/logout-button';
import { SessionGuard } from '../session/session-guard';

type ProviderShellActive =
  | 'dashboard'
  | 'requests'
  | 'offers'
  | 'messages'
  | 'credits'
  | 'subscriptions'
  | 'packages'
  | 'profile';

type ProviderShellProps = {
  user: AuthUser;
  providerId?: string | null;
  businessName?: string | null;
  active?: ProviderShellActive;
  /**
   * Live figures for the sidebar. Every one is optional and nothing is
   * substituted: a value the caller did not load simply does not appear.
   */
  creditBalance?: number | null;
  status?: ProviderStatus | null;
  counts?: Partial<Record<'requests' | 'offers', number>>;
  children: ReactNode;
};

/**
 * `async` because of one number: the unread message badge.
 *
 * It is loaded here rather than passed in, for the reason the customer panel's
 * counters already are — it describes the account, not the screen, and a
 * sidebar that only knew it on the routes that remembered to pass it would show
 * every other route a panel with nothing waiting.
 */
export async function ProviderShell({
  user,
  providerId,
  businessName,
  active = 'dashboard',
  creditBalance = null,
  status = null,
  counts = {},
  children,
}: ProviderShellProps) {
  const display = displayName(user);
  const initials = getInitials(businessName ?? display);
  const subtitle = (businessName && businessName.trim()) || 'Hizmet Veren';
  const requestsHref = providerId ? `/providers/${providerId}/requests` : '/providers/me';
  const offersHref = providerId ? `/providers/${providerId}/offers` : null;
  const creditsHref = providerId ? `/providers/${providerId}/credits` : null;
  const subscriptionsHref = providerId ? `/providers/${providerId}/subscriptions` : null;
  const packagesHref = providerId ? `/providers/${providerId}/package-purchases` : null;
  const profileHref = providerId ? `/providers/${providerId}` : null;
  const unread = await loadUnreadMessageCount();

  const navItems: ReadonlyArray<{
    key: ProviderShellActive;
    label: string;
    Icon: typeof IconGrid;
    href: string | null;
    count?: number | undefined;
  }> = [
    { key: 'dashboard', label: 'Panelim', Icon: IconGrid, href: '/providers/me' },
    {
      key: 'requests',
      label: 'Uygun talepler',
      Icon: IconCompass,
      href: requestsHref,
      count: counts.requests,
    },
    { key: 'offers', label: 'Tekliflerim', Icon: IconSend, href: offersHref, count: counts.offers },
    // New, and deliberately not gated on the provider profile: a provider who
    // won a job can write to that customer, and the entry has to be reachable
    // from every screen in the panel rather than only from the offer they won.
    { key: 'messages', label: 'Mesajlar', Icon: IconMessage, href: '/mesajlar', count: unread?.total },
    { key: 'credits', label: 'Krediler', Icon: IconCoins, href: creditsHref },
    { key: 'subscriptions', label: 'Paketlerim', Icon: IconPackage, href: subscriptionsHref },
    { key: 'packages', label: 'Paket geçmişim', Icon: IconPackage, href: packagesHref },
    { key: 'profile', label: 'İşletme profili', Icon: IconProfile, href: profileHref },
  ];

  const sidebar = (
    <>
      <div className="pdash-brand">
        <Link href="/" aria-label="TakTick ana sayfa">
          <img className="brand-mark-img" style={{ height: 38 }} src="/brand/icon.png" alt="TakTick" />
        </Link>
        <div style={{ minWidth: 0 }}>
          <div className="pdash-brand-title">Hizmet Veren</div>
          <div className="pdash-brand-sub">{subtitle}</div>
        </div>
      </div>

      {/*
        The credit box only appears once a balance has actually been read. It
        never converts credits into a number of offers: an offer costs 1–3
        credits depending on the request's category, and the exact price is
        written on that request's own screen.
      */}
      {typeof creditBalance === 'number' ? (
        <div className="pdash-credit-box">
          <span className="pdash-credit-label">Kredi bakiyesi</span>
          <span className="pdash-credit-value">{creditBalance}</span>
          <span className="pdash-credit-note">
            Teklif maliyeti kategoriye göre değişir; her talebin kredi bedeli detay ekranında
            yazılıdır.
          </span>
          {creditsHref ? (
            <Link className="pdash-btn pdash-btn-primary pdash-btn-block" href={creditsHref}>
              Kredi yükle
            </Link>
          ) : null}
        </div>
      ) : null}

      <nav className="pdash-nav" aria-label="Bölüm navigasyonu">
        {navItems.map((item) => {
          const isActive = item.key === active;
          const { Icon } = item;

          if (item.href) {
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`pdash-nav-item${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span className="pdash-nav-icon">
                  <Icon size={16} />
                </span>
                <span>{item.label}</span>
                {typeof item.count === 'number' ? (
                  <span className="pdash-nav-count">{item.count}</span>
                ) : null}
              </Link>
            );
          }

          return (
            <span
              key={item.key}
              className="pdash-nav-item is-disabled"
              aria-disabled="true"
              title="Profil oluşturulduğunda açılır"
            >
              <span className="pdash-nav-icon">
                <Icon size={16} />
              </span>
              <span>{item.label}</span>
              <span className="pdash-nav-soon">Yakında</span>
            </span>
          );
        })}
      </nav>

      <div className="pdash-sidebar-footer">
        {status ? (
          <div style={{ padding: 16, borderTop: '1px solid var(--color-divider)' }}>
            <span className="pdash-credit-label">Onay durumu</span>
            <div style={{ marginTop: 8 }}>
              <span className={status === 'APPROVED' ? 'tag tag-ink' : 'tag tag-neutral'}>
                {status === 'APPROVED' ? 'Onaylı işletme' : statusLabel(status)}
              </span>
            </div>
          </div>
        ) : null}
        <span className="pdash-nav-item is-disabled" aria-disabled="true" title="Yakında">
          <span className="pdash-nav-icon">
            <IconHelp size={16} />
          </span>
          <span>Destek</span>
          <span className="pdash-nav-soon">Yakında</span>
        </span>
      </div>
    </>
  );

  const topbar = (
    <>
      <div className="pdash-topbar-search" role="search" aria-label="Genel arama (yakında)">
        <IconSearch size={16} />
        <input
          type="search"
          placeholder="Talep, teklif veya referans no..."
          disabled
          aria-disabled="true"
        />
      </div>
      <div className="pdash-topbar-actions">
        <span
          className="pdash-icon-btn"
          role="button"
          aria-label="Bildirimler (yakında)"
          aria-disabled="true"
          title="Yakında"
        >
          <IconBell size={16} />
        </span>
        <ProviderUserMenu
          user={user}
          display={display}
          initials={initials || 'H'}
          creditsHref={creditsHref}
          profileHref={profileHref}
        />
      </div>
    </>
  );

  return (
    <>
      <PanelDrawer
        prefix="pdash"
        navLabel="Hizmet Veren Paneli navigasyonu"
        title="Hizmet Veren"
        sidebar={sidebar}
        topbar={topbar}
      >
        {children}
      </PanelDrawer>

      {/* See the customer panel: it warns, the server decides. */}
      <SessionGuard />
    </>
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
        <span className="lp-user-name">{display}</span>
        <span className="pdash-user-caret">
          <IconChevronDown size={12} />
        </span>
      </summary>
      <div className="pdash-user-menu" role="menu">
        <div className="pdash-user-info">
          <div className="pdash-user-info-name">{display}</div>
          {user.email ? <div className="pdash-user-info-meta">{user.email}</div> : null}
          <div className="pdash-user-info-role">Hizmet Veren</div>
        </div>
        <div className="pdash-user-divider" />
        <Link className="pdash-user-link" href={profileHref ?? '/providers/me'} role="menuitem">
          Profilim
        </Link>
        {creditsHref ? (
          <Link className="pdash-user-link" href={creditsHref} role="menuitem">
            Kredilerim
          </Link>
        ) : null}
        <form action={providerDashboardLogoutAction}>
          {/*
            Announces the logout to this application's other tabs before the
            form posts; the server-side revoke inside the action is what
            actually ends the session.
          */}
          <LogoutButton className="pdash-user-link pdash-user-logout" testId="provider-logout">
            Çıkış Yap
          </LogoutButton>
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

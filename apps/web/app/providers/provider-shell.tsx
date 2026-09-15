import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  apiFetch,
  loadUnreadMessageCount,
  type AuthUser,
  type ProviderStatus,
  type ShowcasePublicationList,
} from '../../lib/api';
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
  IconStar,
  IconStore,
} from '../landing-icons';
import { PanelDrawer } from '../panel-drawer';
import { providerDashboardLogoutAction } from '../login/actions';
import { LogoutButton } from '../session/logout-button';
import { SessionGuard } from '../session/session-guard';

type ProviderShellActive =
  | 'dashboard'
  | 'requests'
  | 'offers'
  | 'reviews'
  | 'showcase'
  | 'showcase-leads'
  | 'messages'
  | 'support'
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
  counts?: Partial<Record<'requests' | 'offers' | 'showcaseLeads', number>>;
  /**
   * Whether this business has ever published a vitrin card.
   *
   * The lead inbox is navigated to off this. A provider who has never bought a
   * placement has no direct leads and cannot have any until they do, so an
   * entry that is permanently empty is an entry that teaches people the sidebar
   * lies. Passed in by the vitrin screens, which already know; worked out here
   * for every other screen, which does not.
   */
  hasShowcaseHistory?: boolean;
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
  hasShowcaseHistory,
  children,
}: ProviderShellProps) {
  const display = displayName(user);
  const initials = getInitials(businessName ?? display);
  const subtitle = (businessName && businessName.trim()) || 'Hizmet Veren';
  const requestsHref = providerId ? `/providers/${providerId}/requests` : '/providers/me';
  const offersHref = providerId ? `/providers/${providerId}/offers` : null;
  const reviewsHref = providerId ? `/providers/${providerId}/degerlendirmeler` : null;
  const creditsHref = providerId ? `/providers/${providerId}/credits` : null;
  const subscriptionsHref = providerId ? `/providers/${providerId}/subscriptions` : null;
  const packagesHref = providerId ? `/providers/${providerId}/package-purchases` : null;
  const showcaseHref = providerId ? `/providers/${providerId}/vitrin` : null;
  const showcaseLeadsHref = providerId ? `/providers/${providerId}/vitrin/talepler` : null;
  const profileHref = providerId ? `/providers/${providerId}` : null;
  const unread = await loadUnreadMessageCount();
  /*
   * Asked here rather than passed in by twelve screens, for the reason the
   * unread badge already is: it describes the account, not the route, and a
   * sidebar that only knew it where somebody remembered to pass it would hide
   * the lead inbox from a provider standing on their own dashboard with a clock
   * running. Skipped entirely when the caller already knows.
   */
  const showcaseLeadsVisible =
    hasShowcaseHistory ?? (providerId ? await loadShowcaseHistory(providerId) : false);

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
    // What customers said about the jobs those offers won. Right under the
    // offers because that is where it comes from; no badge, because a review
    // is not something waiting on the business.
    { key: 'reviews', label: 'Değerlendirmeler', Icon: IconStar, href: reviewsHref },
    // Vitrin sits with the other things the business owns rather than with the
    // ones it answers. It is gated on the provider profile like every other
    // entry that needs an id: a card belongs to a business, and an account with
    // no business has nowhere to put one.
    { key: 'showcase', label: 'Vitrin kartlarım', Icon: IconStore, href: showcaseHref },
    // A separate entry rather than a tab inside the card list, because it is a
    // different kind of thing: the cards are what the business owns, and these
    // are what came back. It also has to be reachable in one click — a direct
    // lead carries a deadline, and burying it a level down would be the panel
    // making a promise harder to keep.
    //
    // The count is the leads still waiting for an answer, and it is the only
    // badge in this list that means "somebody is waiting on you with a clock
    // running".
    {
      key: 'showcase-leads',
      label: 'Vitrin talepleri',
      Icon: IconCompass,
      href: showcaseLeadsHref,
      count: counts.showcaseLeads,
    },
    // New, and deliberately not gated on the provider profile: a provider who
    // won a job can write to that customer, and the entry has to be reachable
    // from every screen in the panel rather than only from the offer they won.
    { key: 'messages', label: 'Mesajlar', Icon: IconMessage, href: '/mesajlar', count: unread?.total },
    // Destek, immediately after Mesajlar and before the business's own settings
    // — the same position it holds in the hizmet alan panel, because the two
    // panels should not need to be learned separately. Not gated on the profile
    // either, and that one matters more here than it does for messaging: a
    // provider whose profile is the very thing that will not save is exactly
    // the person who needs this link, and an entry that appeared only once they
    // had a working profile would be missing whenever it was wanted.
    { key: 'support', label: 'Destek', Icon: IconHelp, href: '/destek' },
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
        {navItems
          /*
           * The lead inbox is dropped from the list entirely rather than shown
           * disabled. The "needs a profile" placeholder below is for sections a
           * provider is *about* to be able to reach; this one is for a section
           * that will not exist for them until they buy a placement, and a
           * greyed row telling somebody so on every screen is noise.
           */
          .filter((item) => item.key !== 'showcase-leads' || showcaseLeadsVisible)
          .map((item) => {
            const isActive = item.key === active;
            const { Icon } = item;

            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`pdash-nav-item${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  data-testid={`pdash-nav-${item.key}`}
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

            // A section that genuinely needs a provider profile, on an account
            // that has not created one yet. It used to be labelled "Yakında",
            // which was simply wrong — the feature has shipped, this account just
            // cannot reach it yet — and told somebody waiting on their own profile
            // to wait for the platform instead. The note now says which of the two
            // it is, and says it in the row rather than only in a `title` a
            // touchscreen never shows.
            return (
              <span
                key={item.key}
                className="pdash-nav-item is-disabled"
                aria-disabled="true"
                data-testid={`pdash-nav-${item.key}`}
              >
                <span className="pdash-nav-icon">
                  <Icon size={16} />
                </span>
                <span>{item.label}</span>
                <span className="pdash-nav-note">Profil gerekli</span>
              </span>
            );
          })}
      </nav>

      {/*
        The approval badge follows the sections instead of being pinned to the
        bottom of the sidebar. It used to share a `margin-top: auto` container
        with a "Destek — Yakında" placeholder, which pushed both to the floor and
        left a column of empty space above them on every screen taller than the
        nav. Destek is a real section now and sits with the others; this is a
        status, so it reads immediately below them.
      */}
      {status ? (
        <div className="pdash-sidebar-status">
          <span className="pdash-credit-label">Onay durumu</span>
          <div style={{ marginTop: 8 }}>
            <span className={status === 'APPROVED' ? 'tag tag-ink' : 'tag tag-neutral'}>
              {status === 'APPROVED' ? 'Onaylı işletme' : statusLabel(status)}
            </span>
          </div>
        </div>
      ) : null}
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

function ProviderUserMenu({
  user,
  display,
  initials,
  creditsHref,
  profileHref,
}: ProviderUserMenuProps) {
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

/**
 * Whether this business has ever had a vitrin run.
 *
 * A failure is "no", not an error: the sidebar is chrome, and an unreachable
 * API must not take a provider's whole panel down with it. The worst case is
 * one hidden entry on a screen the provider can still reach by URL.
 */
async function loadShowcaseHistory(providerId: string): Promise<boolean> {
  try {
    const publication = await apiFetch<ShowcasePublicationList>(
      `/providers/${providerId}/showcase/publication`,
    );
    return publication.hasPublicationHistory;
  } catch {
    return false;
  }
}

export type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
  /**
   * The capability this row's screen needs — the same value the page's own
   * `requireAdmin(...)` asks for and the same one the API's route guard
   * enforces (design D13).
   *
   * Carried here so the sidebar hides exactly what the panel would refuse. A
   * row with no permission is reachable by any staff account that can open the
   * panel at all; there are none today, and `filterNavGroups` treats a missing
   * value as "always visible" rather than as "always hidden", so a row added
   * without one is loud instead of silently gone.
   */
  permission?: string;
  /**
   * A row no permission can open — the root capabilities (RG-7 §12.1).
   *
   * There is deliberately no `AdminPermission` value for defining roles, so
   * this cannot be expressed as one; the flag says the same thing the API's
   * `@Roles(UserRole.SUPER_ADMIN)` says, in the vocabulary a sidebar has.
   */
  superAdminOnly?: boolean;
};

/** The inline icons the sidebar draws (components/nav-icon.tsx). */
export type NavIconName =
  | 'grid'
  | 'file'
  | 'tag'
  | 'users'
  | 'wallet'
  | 'store'
  | 'list'
  | 'settings'
  | 'shield';

export type NavGroup = {
  /** Stable id: the open/closed state and the DOM ids hang off it, not the title. */
  key: string;
  /** The group heading, and the first half of the top bar's "Grup / Sayfa". */
  title: string;
  icon: NavIconName;
  items: NavItem[];
};

/**
 * What one session is given: the dashboard row on its own, above the groups,
 * and the groups themselves. `home` is null when the session cannot open the
 * dashboard — the row is then simply absent, never an empty wrapper.
 */
export type NavMenu = {
  home: NavItem | null;
  groups: NavGroup[];
};

/**
 * "Genel görünüm": a single top-level row, not a group. It has no heading, no
 * fold and no siblings, so it is not modelled as a one-row group either — a
 * group that is only there to hold it would be a ninth heading nobody can see.
 */
export const navHome: NavItem = { href: '/', label: 'Genel görünüm', exact: true, permission: 'DASHBOARD_READ' };
export const NAV_HOME_ICON: NavIconName = 'grid';

/**
 * The sidebar, grouped by what an operator is looking at (ADMIN-DESIGN-001).
 *
 * Exactly eight groups, under the standalone `navHome` row: the design's own,
 * with its "SEO ve adresler" group left out (SEO-004 has no screens yet) and its
 * "Sistem" group split into Operasyon and Yönetim, so the five screens the
 * design had no row for have a place (K1):
 * Paket iadeleri under Finans, Vitrin kartları and Vitrin metin onayları under
 * Vitrin, Kampanya uygunluk incelemesi under Operasyon and Roller ve izinler
 * under Yönetim.
 *
 * Only the grouping and the wording moved. Every row's `permission` (or
 * `superAdminOnly`) is the value it had before this change, and still equal to
 * its page's `requireAdmin(...)` — test/access-boundaries.spec.ts reads every
 * page.tsx to hold that.
 *
 * Not here on purpose: the design's "Eşleşmeler" row (K8) and any counter
 * badge (K2) — neither has a source this panel may show yet.
 */
export const navGroups: NavGroup[] = [
  {
    key: 'talepler',
    title: 'Talepler',
    icon: 'file',
    items: [
      { href: '/requests', label: 'Tüm talepler', permission: 'REQUESTS_READ' },
      { href: '/requests/reports', label: 'Şikayet edilen talepler', permission: 'REQUEST_REPORTS_READ' },
    ],
  },
  {
    key: 'teklifler',
    title: 'Teklifler',
    icon: 'tag',
    items: [{ href: '/offers', label: 'Tüm teklifler', permission: 'OFFERS_READ' }],
  },
  {
    key: 'kisiler',
    title: 'Kişiler',
    icon: 'users',
    items: [
      { href: '/providers', label: 'Hizmet verenler', permission: 'PROVIDERS_READ' },
      { href: '/customers', label: 'Hizmet alanlar', permission: 'CUSTOMERS_READ' },
      { href: '/support', label: 'Destek talepleri', permission: 'SUPPORT_READ' },
    ],
  },
  {
    key: 'finans',
    title: 'Finans',
    icon: 'wallet',
    items: [
      { href: '/finance', label: 'Finans özeti', exact: true, permission: 'FINANCE_READ' },
      { href: '/finance/credit-ledger', label: 'Kredi hareketleri', permission: 'FINANCE_LEDGER_READ' },
      // The design calls it "Elle kredi ekle / düş", but this screen only lists
      // manual adjustments: the form lives on a provider's credit screen (K4).
      // A row that promises a form it does not open would be the first thing an
      // operator reports.
      { href: '/finance/manual-adjustments', label: 'Elle kredi işlemleri', permission: 'FINANCE_LEDGER_READ' },
      { href: '/finance/providers', label: 'İşletme bakiyeleri', permission: 'FINANCE_READ' },
      { href: '/package-purchases', label: 'Paket satışları', permission: 'PACKAGE_PURCHASES_READ' },
      // CMP-006 PR-B: the package money-refund queue. Beside the purchases it
      // is about; its own permission, because reading purchases is not reading
      // who asked for their money back and why.
      { href: '/package-refunds', label: 'Paket iadeleri', permission: 'PACKAGE_REFUND_READ' },
      { href: '/refund-scan', label: 'İade kontrolü', permission: 'OFFER_REFUND_SCAN_READ' },
    ],
  },
  {
    key: 'vitrin',
    title: 'Vitrin',
    icon: 'store',
    items: [
      { href: '/showcase/reviews', label: 'Onay bekleyen kartlar', permission: 'SHOWCASE_REVIEW_READ' },
      { href: '/showcase/placements', label: 'Yayında olan kartlar', permission: 'SHOWCASE_PLACEMENTS_READ' },
      { href: '/showcase/leads', label: 'Vitrinden gelen talepler', permission: 'SHOWCASE_LEADS_READ' },
      // The comments providers flagged on their reviews: in the design's
      // vitrin group, because a review is read on a provider's public card.
      { href: '/provider-reviews/reports', label: 'Şikayet edilen yorumlar', permission: 'PROVIDER_REVIEWS_READ' },
      // Every card in every state, and the consent ledger for the vitrin
      // package texts. Both used to be reachable only from another vitrin
      // screen; K1 gave them rows of their own.
      { href: '/showcase/cards', label: 'Vitrin kartları', permission: 'SHOWCASE_CARDS_READ' },
      { href: '/showcase/price-terms', label: 'Vitrin metin onayları', permission: 'SHOWCASE_TERMS_ACCEPTANCES_READ' },
    ],
  },
  {
    key: 'katalog',
    title: 'Katalog',
    icon: 'list',
    items: [
      { href: '/categories', label: 'Hizmet kategorileri', permission: 'CATALOG_READ' },
      { href: '/showcase/packages', label: 'Vitrin paketleri', permission: 'SHOWCASE_PACKAGES_READ' },
      { href: '/credit-packages', label: 'Kredi paketleri', permission: 'CREDIT_PACKAGES_READ' },
    ],
  },
  {
    key: 'operasyon',
    title: 'Operasyon',
    icon: 'settings',
    items: [
      { href: '/operations-settings', label: 'Operasyon ayarları', permission: 'OPERATIONS_SETTINGS_READ' },
      { href: '/campaigns', label: 'Kampanyalar', permission: 'CAMPAIGNS_READ' },
      // CMP-006 PR-C: events the promotion eligibility gate held for a person.
      // Right under the campaigns whose benefits it holds back.
      {
        href: '/promotion-eligibility',
        label: 'Kampanya uygunluk incelemesi',
        permission: 'PROMOTION_ELIGIBILITY_REVIEW',
      },
      { href: '/notifications', label: 'Gönderilen bildirimler', permission: 'NOTIFICATION_LOGS_READ' },
    ],
  },
  {
    key: 'yonetim',
    title: 'Yönetim',
    icon: 'shield',
    items: [
      { href: '/users', label: 'Yönetici hesapları', permission: 'ADMIN_USERS_READ' },
      // Root: defining authority is not part of the authority it defines, so
      // there is no permission that could reveal this row (RG-7 §12.1).
      { href: '/roles', label: 'Roller ve izinler', superAdminOnly: true },
      { href: '/company-settings', label: 'Şirket ve e-posta bilgileri', permission: 'COMPANY_SETTINGS_READ' },
    ],
  },
];

/** Every row the sidebar can show: the dashboard row, then each group's rows. */
export function allNavItems(): NavItem[] {
  return [navHome, ...navGroups.flatMap((group) => group.items)];
}

function matchesNavItem(item: NavItem, pathname: string): boolean {
  if (item.exact) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Whether a sidebar row is the one the operator is on.
 *
 * A row matches its own path and everything under it, so `/requests` stays lit
 * on `/requests/<id>`. When two rows both match — `/requests` and
 * `/requests/reports` on the report queue — only the more specific one wins,
 * otherwise the sidebar highlights two rows for one screen.
 *
 * Specificity is judged against the full list, not the session's filtered one:
 * a session that holds `/requests` but not `/requests/reports` must not see
 * "Tüm talepler" lit on a queue it was refused.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (!matchesNavItem(item, pathname)) {
    return false;
  }

  return !allNavItems().some(
    (other) =>
      other !== item &&
      other.href.length > item.href.length &&
      other.href.startsWith(`${item.href}/`) &&
      matchesNavItem(other, pathname),
  );
}

/**
 * The row the operator is on, looked up in the groups this session was given.
 *
 * The top bar's "Grup / Sayfa" comes from here. It takes the filtered groups
 * rather than reading `navGroups` itself (F18): a label is not data, but a top
 * bar that names a row the sidebar hides is still a map of what the session
 * cannot open.
 */
export function findActiveNavEntry(
  menu: NavMenu,
  pathname: string,
): { group: NavGroup | null; item: NavItem } | null {
  if (menu.home && isNavItemActive(menu.home, pathname)) {
    return { group: null, item: menu.home };
  }
  for (const group of menu.groups) {
    for (const item of group.items) {
      if (isNavItemActive(item, pathname)) {
        return { group, item };
      }
    }
  }
  return null;
}

/**
 * The sidebar this session should see.
 *
 * Hides a row whose permission the session does not hold, and drops a group
 * once every row in it is gone — an empty "Finans" heading is worse than no
 * heading, because it says there is something there.
 *
 * A super admin sees everything, which the caller expresses by passing a `can`
 * that always answers true. A row with no permission is always shown: the
 * failure a new row is most likely to have is a forgotten permission, and a
 * visible row that 403s is a bug somebody reports, while an invisible one is a
 * bug nobody notices.
 */
export function filterNavGroups(
  groups: readonly NavGroup[],
  can: (permission: string) => boolean,
  isSuperAdmin = false,
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => mayOpen(item, can, isSuperAdmin)),
    }))
    .filter((group) => group.items.length > 0);
}

function mayOpen(item: NavItem, can: (permission: string) => boolean, isSuperAdmin: boolean): boolean {
  if (item.superAdminOnly) {
    return isSuperAdmin;
  }
  return !item.permission || can(item.permission);
}

/** The whole menu for one session: `filterNavGroups` plus the dashboard row, by the same rule. */
export function filterNavMenu(can: (permission: string) => boolean, isSuperAdmin = false): NavMenu {
  return {
    home: mayOpen(navHome, can, isSuperAdmin) ? navHome : null,
    groups: filterNavGroups(navGroups, can, isSuperAdmin),
  };
}

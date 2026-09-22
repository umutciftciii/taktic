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

export type NavGroup = {
  title: string;
  items: NavItem[];
};

export const navGroups: NavGroup[] = [
  {
    title: 'Genel',
    items: [{ href: '/', label: 'Dashboard', exact: true, permission: 'DASHBOARD_READ' }],
  },
  {
    title: 'Operasyon',
    items: [
      { href: '/requests', label: 'Talepler', permission: 'REQUESTS_READ' },
      { href: '/requests/reports', label: 'Talep bildirimleri', permission: 'REQUEST_REPORTS_READ' },
      // The other report queue: comments providers flagged on their reviews.
      // Beside the request queue because an operator triages both the same
      // way — read what was reported, decide, move on.
      { href: '/provider-reviews/reports', label: 'Değerlendirme bildirimleri', permission: 'PROVIDER_REVIEWS_READ' },
      { href: '/customers', label: 'Hizmet Alanlar', permission: 'CUSTOMERS_READ' },
      { href: '/offers', label: 'Teklifler', permission: 'OFFERS_READ' },
      { href: '/providers', label: 'Hizmet Verenler', permission: 'PROVIDERS_READ' },
      { href: '/support', label: 'Destek Talepleri', permission: 'SUPPORT_READ' },
      /*
       * Vitrin, as three entries rather than five.
       *
       * It used to carry "Vitrin İncelemeleri", "Vitrin Kartları", "Vitrin
       * Yerleşimleri", "Vitrin Talepleri" and "Vitrin Metin Onayları" — five
       * rows in one sidebar, three of them named after tables. An operator
       * opening the panel had to know what a "yerleşim" was before they could
       * decide which row held the thing they were looking for.
       *
       * The three that are left are the three jobs: read what is waiting to be
       * approved, look at what is on the air, and answer what customers sent.
       * "Vitrin Kartları" (every card, in every state) is reachable from the
       * review queue, and "Vitrin Metin Onayları" (the consent ledger) from the
       * package catalogue — both are things an operator goes looking for while
       * already inside vitrin, not places they navigate to cold.
       */
      { href: '/showcase/reviews', label: 'Kart incelemeleri', permission: 'SHOWCASE_REVIEW_READ' },
      // The paid side of vitrin. Under Operasyon with the rest of it rather
      // than under Finans: a run is something an operator suspends, resumes and
      // investigates, and the money it represents is already visible on the
      // purchase it came from.
      { href: '/showcase/placements', label: 'Yayındaki kartlar', permission: 'SHOWCASE_PLACEMENTS_READ' },
      { href: '/showcase/leads', label: 'Vitrin talepleri', permission: 'SHOWCASE_LEADS_READ' },
    ],
  },
  {
    title: 'Katalog',
    items: [
      { href: '/categories', label: 'Kategoriler', permission: 'QUESTIONS_READ' },
      // The vitrin catalogue is a catalogue: an operator maintains it the way
      // they maintain credit packages, and it belongs beside them rather than
      // with the runs it produces.
      { href: '/showcase/packages', label: 'Paketler', permission: 'SHOWCASE_PACKAGES_READ' },
      { href: '/credit-packages', label: 'Kredi Paketleri', permission: 'CREDIT_PACKAGES_READ' },
    ],
  },
  {
    title: 'Finans',
    items: [
      { href: '/finance', label: 'Dashboard', exact: true, permission: 'FINANCE_READ' },
      { href: '/finance/credit-ledger', label: 'Kredi Hareketleri', permission: 'FINANCE_LEDGER_READ' },
      { href: '/finance/manual-adjustments', label: 'Manuel İşlemler', permission: 'FINANCE_READ' },
      { href: '/finance/providers', label: 'Provider Finans Bakiyeleri', permission: 'FINANCE_READ' },
      { href: '/package-purchases', label: 'Paket Satın Almaları', permission: 'PACKAGE_PURCHASES_READ' },
      { href: '/refund-scan', label: 'İade Taraması', permission: 'OFFER_REFUND_SCAN_READ' },
    ],
  },
  {
    title: 'Yönetim',
    items: [
      { href: '/users', label: 'Admin Kullanıcıları', permission: 'ADMIN_USERS_READ' },
      // Root: defining authority is not part of the authority it defines, so
      // there is no permission that could reveal this row (RG-7 §12.1).
      { href: '/roles', label: 'Roller ve İzinler', superAdminOnly: true },
      { href: '/company-settings', label: 'Şirket ve E-posta', permission: 'COMPANY_SETTINGS_READ' },
      { href: '/operations-settings', label: 'Operasyon Ayarları', permission: 'OPERATIONS_SETTINGS_READ' },
      // Campaign drafts (CMP-002 S1). Under Yönetim beside the operations
      // switches rather than under Finans: in this slice a campaign is a
      // definition an operator drafts, not money that moves — the engine
      // that would move it is off and has no switch here.
      { href: '/campaigns', label: 'Kampanyalar', permission: 'CAMPAIGNS_READ' },
      { href: '/notifications', label: 'Bildirim Geçmişi', permission: 'NOTIFICATION_LOGS_READ' },
    ],
  },
];

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
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (!matchesNavItem(item, pathname)) {
    return false;
  }

  return !navGroups.some((group) =>
    group.items.some(
      (other) =>
        other !== item &&
        other.href.length > item.href.length &&
        other.href.startsWith(`${item.href}/`) &&
        matchesNavItem(other, pathname),
    ),
  );
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
      items: group.items.filter((item) => {
        if (item.superAdminOnly) {
          return isSuperAdmin;
        }
        return !item.permission || can(item.permission);
      }),
    }))
    .filter((group) => group.items.length > 0);
}

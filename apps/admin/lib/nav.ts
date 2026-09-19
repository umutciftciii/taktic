export type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

export const navGroups: NavGroup[] = [
  {
    title: 'Genel',
    items: [{ href: '/', label: 'Dashboard', exact: true }],
  },
  {
    title: 'Operasyon',
    items: [
      { href: '/requests', label: 'Talepler' },
      { href: '/requests/reports', label: 'Talep bildirimleri' },
      // The other report queue: comments providers flagged on their reviews.
      // Beside the request queue because an operator triages both the same
      // way — read what was reported, decide, move on.
      { href: '/provider-reviews/reports', label: 'Değerlendirme bildirimleri' },
      { href: '/customers', label: 'Hizmet Alanlar' },
      { href: '/offers', label: 'Teklifler' },
      { href: '/providers', label: 'Hizmet Verenler' },
      { href: '/support', label: 'Destek Talepleri' },
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
      { href: '/showcase/reviews', label: 'Kart incelemeleri' },
      // The paid side of vitrin. Under Operasyon with the rest of it rather
      // than under Finans: a run is something an operator suspends, resumes and
      // investigates, and the money it represents is already visible on the
      // purchase it came from.
      { href: '/showcase/placements', label: 'Yayındaki kartlar' },
      { href: '/showcase/leads', label: 'Vitrin talepleri' },
    ],
  },
  {
    title: 'Katalog',
    items: [
      { href: '/categories', label: 'Kategoriler' },
      // The vitrin catalogue is a catalogue: an operator maintains it the way
      // they maintain credit packages, and it belongs beside them rather than
      // with the runs it produces.
      { href: '/showcase/packages', label: 'Paketler' },
      { href: '/credit-packages', label: 'Kredi Paketleri' },
    ],
  },
  {
    title: 'Finans',
    items: [
      { href: '/finance', label: 'Dashboard', exact: true },
      { href: '/finance/credit-ledger', label: 'Kredi Hareketleri' },
      { href: '/finance/manual-adjustments', label: 'Manuel İşlemler' },
      { href: '/finance/providers', label: 'Provider Finans Bakiyeleri' },
      { href: '/package-purchases', label: 'Paket Satın Almaları' },
      { href: '/refund-scan', label: 'İade Taraması' },
    ],
  },
  {
    title: 'Yönetim',
    items: [
      { href: '/users', label: 'Admin Kullanıcıları' },
      { href: '/company-settings', label: 'Şirket ve E-posta' },
      { href: '/operations-settings', label: 'Operasyon Ayarları' },
      // Campaign drafts (CMP-002 S1). Under Yönetim beside the operations
      // switches rather than under Finans: in this slice a campaign is a
      // definition an operator drafts, not money that moves — the engine
      // that would move it is off and has no switch here.
      { href: '/campaigns', label: 'Kampanyalar' },
      { href: '/notifications', label: 'Bildirim Geçmişi' },
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

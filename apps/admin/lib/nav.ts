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
      { href: '/notifications', label: 'Bildirim Geçmişi' },
    ],
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

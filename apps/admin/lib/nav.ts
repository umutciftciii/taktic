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
    ],
  },
  {
    title: 'Katalog',
    items: [
      { href: '/categories', label: 'Kategoriler' },
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
    items: [{ href: '/users', label: 'Kullanıcılar' }],
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from './login/actions';

const navItems: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/requests', label: 'Talepler' },
  { href: '/providers', label: 'Hizmet Verenler' },
  { href: '/offers', label: 'Teklifler' },
  { href: '/categories', label: 'Kategoriler' },
  { href: '/credit-packages', label: 'Kredi Paketleri' },
  { href: '/package-purchases', label: 'Paket Talepleri' },
  { href: '/refund-scan', label: 'İade Taraması' },
];

type AdminShellProps = {
  children: ReactNode;
};

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return children;
  }

  return (
    <div className="admin-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <Link className="brand" href="/">
            <span className="brand-mark">T</span>
            <span>TakTic Admin</span>
          </Link>
          <nav className="app-nav" aria-label="Admin navigation">
            {navItems.map((item) => {
              const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link key={item.href} className={isActive ? 'active' : ''} href={item.href}>
                  {item.label}
                </Link>
              );
            })}
            <form action={logoutAction}>
              <button className="btn btn-secondary btn-sm" type="submit">Çıkış</button>
            </form>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}

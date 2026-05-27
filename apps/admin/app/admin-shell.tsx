'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from './login/actions';

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
            <Link href="/">Dashboard</Link>
            <Link href="/requests">Talepler</Link>
            <Link href="/providers">Hizmet Verenler</Link>
            <Link href="/offers">Teklifler</Link>
            <Link href="/credit-packages">Krediler / Paketler</Link>
            <Link href="/package-purchases">Satın Almalar</Link>
            <Link href="/refund-scan">Refund Scan</Link>
            <form action={logoutAction}>
              <button className="button-secondary" type="submit">Logout</button>
            </form>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}

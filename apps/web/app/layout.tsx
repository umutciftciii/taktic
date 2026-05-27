import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { CategorySearch } from './category-search';

export const metadata: Metadata = {
  title: 'TakTic',
  description: 'Yerel hizmet pazaryeri',
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="tr">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <div className="app-header-inner">
              <Link className="brand" href="/">
                <span className="brand-mark">T</span>
                <span>TakTic</span>
              </Link>
              <div className="app-header-search">
                <CategorySearch />
              </div>
              <nav className="app-nav" aria-label="Site navigation">
                <Link href="/categories">Kategoriler</Link>
                <Link href="/providers/register">Hizmet Ver</Link>
                <Link href="/requests/my">Taleplerim</Link>
                <Link href="/providers/me">Panelim</Link>
                <Link href="/login">Giriş</Link>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

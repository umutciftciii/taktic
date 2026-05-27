import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'TakTic',
  description: 'Local services marketplace foundation.',
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
              <nav className="app-nav" aria-label="Site navigation">
                <Link href="/categories">Kategoriler</Link>
                <Link href="/categories">Hizmet Al</Link>
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

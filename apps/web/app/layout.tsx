import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { SiteFooter } from './site-footer';

export const metadata: Metadata = {
  title: 'TakTic — Doğrulanmış hizmet, adil teklif',
  description:
    'TakTic, yerel hizmet pazaryerinde doğrulanmış talepler ve adil teklif kredisiyle çalışır.',
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="tr">
      <body>
        <div className="app-shell">
          <header className="lp-header" id="site-header">
            <div className="lp-container lp-header-inner">
              <Link className="lp-logo" href="/" aria-label="TakTic ana sayfa">
                <span className="lp-logo-mark">T</span>
                <span>TakTic</span>
              </Link>

              <nav className="lp-nav" aria-label="Site navigation">
                <Link href="/categories">Kategoriler</Link>
                <Link href="/#nasil-calisir">Nasıl Çalışır</Link>
                <Link href="/providers/register">Hizmet Ver</Link>
                <Link href="/requests/my">Taleplerim</Link>
                <Link href="/login">Giriş</Link>
              </nav>

              <div className="lp-header-cta">
                <Link className="btn btn-secondary btn-sm" href="/providers/register">
                  Hizmet Veren Ol
                </Link>
                <Link className="btn btn-primary btn-sm" href="/categories">
                  Hizmet Al
                </Link>
              </div>
            </div>
          </header>

          {children}

          <SiteFooter />
        </div>
      </body>
    </html>
  );
}

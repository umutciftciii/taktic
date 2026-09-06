import type { Metadata } from 'next';
import { Archivo } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { apiFetch, getCurrentUser, type ProviderDashboard } from '../lib/api';
import { PublicChrome } from './public-chrome';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Archivo is the system's only family — 400 for body, 600 for labels, 800 for
 * headings and button labels. Self-hosted through next/font so the design does
 * not depend on a third-party stylesheet at runtime.
 */
const archivo = Archivo({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '600', '800'],
  display: 'swap',
  variable: '--font-archivo',
});

export const metadata: Metadata = {
  title: 'TakTic — Yerel hizmet teklifleri, adil teklif kredisi',
  description:
    'TakTic, yerel hizmet pazaryerinde talebinizi hizmet verenlere ulaştırır; gelen teklifleri karşılaştırarak seçim yaparsınız.',
};

type RootLayoutProps = {
  children: ReactNode;
};

export default async function RootLayout({ children }: RootLayoutProps) {
  const user = await getCurrentUser();

  let providerId: string | null = null;
  if (user?.role === 'PROVIDER') {
    try {
      const dashboard = await apiFetch<ProviderDashboard>('/providers/me/dashboard');
      providerId = dashboard.provider?.id ?? null;
    } catch {
      providerId = null;
    }
  }

  return (
    <html lang="tr" className={archivo.variable}>
      <body>
        <div className="app-shell">
          {/*
            A panel screen draws its own sidebar and topbar, account menu
            included, so it is handed no header and no footer at all. Rendering
            them and hiding them in CSS is what used to leave a second, 0×0
            account menu and logout on every panel route.
          */}
          <PublicChrome>
            <SiteHeader user={user} providerId={providerId} />
          </PublicChrome>

          {children}

          <PublicChrome>
            <SiteFooter isAuthenticated={!!user} />
          </PublicChrome>
        </div>
      </body>
    </html>
  );
}

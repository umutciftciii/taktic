import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Before globals.css, as the next/font/google import was: the font CSS keeps
// its place in the cascade.
import { archivo } from './fonts';
import './globals.css';
import { apiFetch, getCurrentUser, type ProviderDashboard } from '../lib/api';
import { rootMetadata } from '../lib/seo-metadata';
import { PublicChrome } from './public-chrome';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * The default every page inherits: the site's title and description, and
 * `noindex, nofollow`. A page that may be indexed says so itself through
 * `publicPageMetadata` (lib/seo-metadata.ts); everything that does not —
 * every panel, form, success and error screen — stays out of the index
 * without having to know it. `metadataBase` is set only when the deployment
 * has declared a public origin, so no absolute URL is ever built from a
 * guess. A function rather than a constant because the environment is read
 * at request time, not at build.
 */
export async function generateMetadata(): Promise<Metadata> {
  return rootMetadata();
}

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

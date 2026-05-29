import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { apiFetch, getCurrentUser, type ProviderDashboard } from '../lib/api';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export const metadata: Metadata = {
  title: 'TakTic — Doğrulanmış hizmet, adil teklif',
  description:
    'TakTic, yerel hizmet pazaryerinde doğrulanmış talepler ve adil teklif kredisiyle çalışır.',
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
    <html lang="tr">
      <body>
        <div className="app-shell">
          <SiteHeader user={user} providerId={providerId} />

          {children}

          <SiteFooter isAuthenticated={!!user} />
        </div>
      </body>
    </html>
  );
}

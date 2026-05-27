import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminShell } from './admin-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'TakTic Admin',
  description: 'TakTic admin foundation.',
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="tr">
      <body>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}

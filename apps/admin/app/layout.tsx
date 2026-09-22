import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminShell } from './admin-shell';
import { readAdminAccess } from '../lib/api';
import { filterNavGroups, navGroups } from '../lib/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'TakTic Admin',
  description: 'TakTic yönetim paneli',
};

type RootLayoutProps = {
  children: ReactNode;
};

/**
 * The sidebar is built here, on the server, from the same
 * `GET /admin/me/permissions` the route guards answer from (design D13): a row
 * the session could not open is not rendered, rather than rendered and then
 * refused.
 *
 * Signed out — on `/login`, or with an expired session — `readAdminAccess`
 * returns null and the shell renders no navigation at all. It must not redirect
 * from here: this layout wraps `/login` too.
 */
export default async function RootLayout({ children }: RootLayoutProps) {
  const access = await readAdminAccess();
  const groups = access
    ? filterNavGroups(
        navGroups,
        (permission) => access.isSuperAdmin || access.permissions.includes(permission),
        access.isSuperAdmin,
      )
    : [];

  return (
    <html lang="tr">
      <body>
        <AdminShell navGroups={groups}>{children}</AdminShell>
      </body>
    </html>
  );
}

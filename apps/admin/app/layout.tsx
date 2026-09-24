import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminShell } from './admin-shell';
import { readAdminAccess, readAdminIdentity } from '../lib/api';
import { summarizeAdminAccount } from '../lib/admin-account';
import { filterNavMenu, type NavMenu } from '../lib/nav';
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
 *
 * The account block at the foot of the sidebar reads the same answer: its
 * "Süper yönetici" / "Yetkili personel · N yetki" line is counted from these
 * permissions (K13). The name beside it comes from `/auth/me`, which says who
 * is signed in and nothing about what they may do.
 */
export default async function RootLayout({ children }: RootLayoutProps) {
  const [access, identity] = await Promise.all([readAdminAccess(), readAdminIdentity()]);
  const menu: NavMenu = access
    ? filterNavMenu(
        (permission) => access.isSuperAdmin || access.permissions.includes(permission),
        access.isSuperAdmin,
      )
    : { home: null, groups: [] };
  const account = access ? summarizeAdminAccount(access, identity) : null;

  return (
    <html lang="tr">
      <body>
        <AdminShell navMenu={menu} account={account}>{children}</AdminShell>
      </body>
    </html>
  );
}

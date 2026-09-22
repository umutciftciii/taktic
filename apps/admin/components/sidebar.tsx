'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, type NavGroup } from '../lib/nav';

type SidebarProps = {
  /**
   * The rows this session may open, already filtered on the server against
   * `GET /admin/me/permissions`. Passed in rather than imported, so the sidebar
   * cannot show a row the API would refuse — it does not know the full list.
   */
  groups: NavGroup[];
  onNavigate?: () => void;
};

export function Sidebar({ groups, onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav className="admin-sidebar-nav" aria-label="Admin navigasyonu">
      <Link className="admin-sidebar-brand" href="/" onClick={onNavigate} aria-label="TakTick yönetim paneli">
        <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <span className="admin-sidebar-brand-tag">Yönetim Paneli</span>
      </Link>

      <div className="admin-sidebar-groups">
        {groups.map((group) => (
          <div className="admin-sidebar-group" key={group.title}>
            <h2 className="admin-sidebar-group-title">{group.title}</h2>
            <ul className="admin-sidebar-list">
              {group.items.map((item) => {
                const active = isNavItemActive(item, pathname);
                return (
                  <li key={item.href}>
                    <Link
                      className={active ? 'admin-sidebar-link is-active' : 'admin-sidebar-link'}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={onNavigate}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, navGroups } from '../lib/nav';

type SidebarProps = {
  onNavigate?: () => void;
};

export function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav className="admin-sidebar-nav" aria-label="Admin navigasyonu">
      <Link className="admin-sidebar-brand" href="/" onClick={onNavigate} aria-label="TakTick yönetim paneli">
        <img className="admin-brand-logo" src="/brand/logo.png" alt="TakTick" />
        <span className="admin-sidebar-brand-tag">Yönetim Paneli</span>
      </Link>

      <div className="admin-sidebar-groups">
        {navGroups.map((group) => (
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

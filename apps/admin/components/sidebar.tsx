'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { AdminAccountSummary } from '../lib/admin-account';
import { isNavItemActive, NAV_HOME_ICON, type NavMenu } from '../lib/nav';
import { BrandMark } from './brand-mark';
import { NavIcon } from './nav-icon';

type SidebarProps = {
  /**
   * The rows this session may open, already filtered on the server against
   * `GET /admin/me/permissions`. Passed in rather than imported, so the sidebar
   * cannot show a row the API would refuse — it does not know the full list.
   */
  menu: NavMenu;
  /** The account block at the foot; null when the session could not be read. */
  account: AdminAccountSummary | null;
  /**
   * Icon mode, already resolved against the viewport: true only on a desktop
   * whose operator chose it. In the phone drawer the full menu always shows.
   */
  rail: boolean;
  onToggleRail: () => void;
  /** Icon mode's group button: widen the menu so the group can open. */
  onExpandRail: () => void;
  onNavigate?: () => void;
};

export function Sidebar({ menu, account, rail, onToggleRail, onExpandRail, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  // Every group starts open. A collapsed group is the operator's choice for
  // this page view; it is not remembered, so nobody comes back to a menu with
  // the row they need folded away.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const homeActive = menu.home ? isNavItemActive(menu.home, pathname) : false;

  const toggleGroup = (key: string) => {
    if (rail) {
      // In icon mode a group has no rows on screen to fold. Its icon is the way
      // back to them: the menu widens with that group open.
      setClosed((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      onExpandRail();
      return;
    }
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className="admin-sidebar-nav" aria-label="Admin navigasyonu">
      <div className="admin-sidebar-head">
        <Link className="admin-sidebar-brand" href="/" onClick={onNavigate} aria-label="TakTick yönetim paneli">
          <BrandMark />
          <span className="admin-sidebar-brand-text">
            <span className="admin-sidebar-brand-name">TakTick</span>
            <span className="admin-sidebar-brand-tag">Yönetim</span>
          </span>
        </Link>
        {/* Desktop only (hidden in the drawer by CSS): the drawer is already the narrow form. */}
        <button
          type="button"
          className="admin-rail-toggle"
          data-testid="admin-rail-toggle"
          onClick={onToggleRail}
          aria-pressed={rail}
          aria-label={rail ? 'Menüyü genişlet' : 'Menüyü daralt'}
          title={rail ? 'Menüyü genişlet' : 'Menüyü daralt'}
        >
          <NavIcon name="panel" />
        </button>
      </div>

      <div className="admin-sidebar-groups">
        {/*
          "Genel görünüm" is a single top-level row, not a group: no heading, no
          fold, no role="group" around it. Absent when the session cannot open
          the dashboard.
        */}
        {menu.home ? (
          <ul className="admin-sidebar-list is-home">
            <li>
              <Link
                className={homeActive ? 'admin-sidebar-link has-icon is-active' : 'admin-sidebar-link has-icon'}
                href={menu.home.href}
                aria-current={homeActive ? 'page' : undefined}
                onClick={onNavigate}
                title={rail ? menu.home.label : undefined}
                data-testid="admin-nav-home"
              >
                <NavIcon name={NAV_HOME_ICON} />
                <span className="admin-sidebar-link-label">{menu.home.label}</span>
              </Link>
            </li>
          </ul>
        ) : null}

        {menu.groups.map((group) => {
          const listId = `admin-nav-${group.key}`;
          const open = !rail && !closed.has(group.key);
          const holdsActive = group.items.some((item) => isNavItemActive(item, pathname));

          return (
            <div
              className={holdsActive ? 'admin-sidebar-group holds-active' : 'admin-sidebar-group'}
              key={group.key}
              role="group"
              aria-labelledby={`${listId}-heading`}
              data-nav-group={group.key}
            >
              <button
                id={`${listId}-heading`}
                type="button"
                className="admin-sidebar-group-toggle"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggleGroup(group.key)}
                title={rail ? group.title : undefined}
              >
                <NavIcon name={group.icon} />
                <span className="admin-sidebar-group-title">{group.title}</span>
                <NavIcon
                  name={open ? 'chevronDown' : 'chevronRight'}
                  size={14}
                  strokeWidth={2}
                  className="admin-sidebar-chevron"
                />
              </button>
              <ul id={listId} className="admin-sidebar-list" hidden={!open}>
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
                        <span className="admin-sidebar-link-label">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {account ? (
        <div className="admin-sidebar-account" data-testid="admin-account">
          <span className="admin-sidebar-account-initials" aria-hidden="true">
            {account.initials}
          </span>
          <span className="admin-sidebar-account-text">
            {account.displayName ? (
              <span className="admin-sidebar-account-name">{account.displayName}</span>
            ) : null}
            <span className="admin-sidebar-account-role" data-testid="admin-account-role">
              {account.roleLabel}
            </span>
          </span>
        </div>
      ) : null}
    </nav>
  );
}

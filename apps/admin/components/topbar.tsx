'use client';

import type { RefObject } from 'react';
import { usePathname } from 'next/navigation';
import { isNavItemActive, navGroups } from '../lib/nav';
import { logoutAction } from '../app/login/actions';
import { LogoutButton } from '../app/session/logout-button';

type TopbarProps = {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  sidebarId: string;
  toggleRef: RefObject<HTMLButtonElement | null>;
};

export function Topbar({ onToggleSidebar, sidebarOpen, sidebarId, toggleRef }: TopbarProps) {
  const pathname = usePathname();
  const current = findActive(pathname);

  return (
    <header className="admin-topbar">
      <div className="admin-topbar-inner">
        <button
          ref={toggleRef}
          type="button"
          className="admin-topbar-toggle"
          data-testid="panel-drawer-toggle"
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls={sidebarId}
          aria-label={sidebarOpen ? 'Menüyü kapat' : 'Menüyü aç'}
        >
          <span aria-hidden="true">☰</span>
        </button>

        <div className="admin-topbar-context">
          {current ? (
            <>
              <span className="admin-topbar-eyebrow">{current.group}</span>
              <span className="admin-topbar-title">{current.item.label}</span>
            </>
          ) : (
            <span className="admin-topbar-title">TakTic Admin</span>
          )}
        </div>

        <form action={logoutAction} className="admin-topbar-actions">
          {/*
            Announces the logout to this panel's other tabs before the form
            posts; the server-side revoke inside the action is what actually
            ends the session.
          */}
          <LogoutButton className="btn btn-secondary btn-sm" testId="admin-logout">
            Çıkış
          </LogoutButton>
        </form>
      </div>
    </header>
  );
}

function findActive(pathname: string) {
  for (const group of navGroups) {
    for (const item of group.items) {
      if (isNavItemActive(item, pathname)) {
        return { group: group.title, item };
      }
    }
  }
  return null;
}

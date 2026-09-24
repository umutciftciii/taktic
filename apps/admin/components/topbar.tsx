'use client';

import type { RefObject } from 'react';
import { usePathname } from 'next/navigation';
import { findActiveNavEntry, type NavGroup } from '../lib/nav';
import { LogoutButton } from '../app/session/logout-button';
import { NavIcon } from './nav-icon';

type TopbarProps = {
  /** The session's filtered sidebar; the "Grup / Sayfa" line is read from it (F18). */
  groups: NavGroup[];
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  sidebarId: string;
  toggleRef: RefObject<HTMLButtonElement | null>;
};

/**
 * The 56px bar over every signed-in screen: where you are, and the way out.
 *
 * The design's search field and notification bell are not here (K3): neither
 * has a source this panel may query on a session's behalf, and a control that
 * does nothing is worse than no control.
 */
export function Topbar({ groups, onToggleSidebar, sidebarOpen, sidebarId, toggleRef }: TopbarProps) {
  const pathname = usePathname();
  const current = findActiveNavEntry(groups, pathname);

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
          <NavIcon name="menu" size={18} />
        </button>

        <div className="admin-topbar-context" data-testid="admin-topbar-context">
          {current ? (
            <>
              <span className="admin-topbar-eyebrow">{current.group.title}</span>
              <span className="admin-topbar-sep" aria-hidden="true">
                /
              </span>
              <span className="admin-topbar-title">{current.item.label}</span>
            </>
          ) : (
            <span className="admin-topbar-title">TakTick Yönetim</span>
          )}
        </div>

        <form action="/logout" method="post" className="admin-topbar-actions">
          {/*
            Announces the logout to this panel's other tabs before the form
            posts; the server-side revoke inside the action is what actually
            ends the session.
          */}
          <LogoutButton className="btn btn-secondary btn-sm admin-logout" testId="admin-logout">
            Çıkış
          </LogoutButton>
        </form>
      </div>
    </header>
  );
}

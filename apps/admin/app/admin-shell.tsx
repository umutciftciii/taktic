'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '../components/sidebar';
import { Topbar } from '../components/topbar';
import { SessionGuard } from './session/session-guard';

type AdminShellProps = {
  children: ReactNode;
};

const DESKTOP_QUERY = '(min-width: 1024px)';
const SIDEBAR_ID = 'admin-sidebar';

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Whether the drawer was open a render ago. Focus only moves on the
   * transition, so an unrelated re-render does not pull it back out of whatever
   * the person is using inside the drawer.
   */
  const wasOpen = useRef(false);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  /**
   * Crossing into the desktop layout closes it. The toggle is display:none
   * there, so an open flag left behind would be a drawer nobody could shut.
   */
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => {
      if (query.matches) setSidebarOpen(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // Escape closes, Tab stays inside, and the page behind the drawer does not
  // scroll while it covers it.
  useEffect(() => {
    if (!sidebarOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeSidebar();
        return;
      }

      if (event.key !== 'Tab') return;

      const sidebar = sidebarRef.current;
      if (!sidebar) return;

      const focusable = sidebar.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !sidebar.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('has-drawer-open');

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('has-drawer-open');
    };
  }, [sidebarOpen, closeSidebar]);

  useEffect(() => {
    if (sidebarOpen && !wasOpen.current) {
      closeRef.current?.focus();
    } else if (!sidebarOpen && wasOpen.current) {
      toggleRef.current?.focus();
    }
    wasOpen.current = sidebarOpen;
  }, [sidebarOpen]);

  if (pathname === '/login' || pathname === '/admin-invite') {
    return <>{children}</>;
  }

  return (
    <div className={sidebarOpen ? 'admin-shell is-sidebar-open' : 'admin-shell'}>
      <aside
        ref={sidebarRef}
        id={SIDEBAR_ID}
        className="admin-sidebar"
        aria-label="Birincil navigasyon"
      >
        <div className="admin-drawer-head">
          <button
            ref={closeRef}
            type="button"
            className="admin-drawer-close"
            onClick={closeSidebar}
            aria-label="Menüyü kapat"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <Sidebar onNavigate={closeSidebar} />
      </aside>

      {/*
        Only in the tree while it can be used. A permanently mounted backdrop
        with tabIndex -1 is still an element a screen reader walks past on every
        screen, and there is nothing to say about it when the drawer is shut.
      */}
      {sidebarOpen ? (
        <button
          type="button"
          className="admin-sidebar-backdrop"
          aria-label="Menüyü kapat"
          onClick={closeSidebar}
        />
      ) : null}

      <div className="admin-main">
        <Topbar
          onToggleSidebar={toggleSidebar}
          sidebarOpen={sidebarOpen}
          sidebarId={SIDEBAR_ID}
          toggleRef={toggleRef}
        />
        <div className="admin-content">{children}</div>
      </div>

      {/*
        Mounted here rather than in the layout, so it is absent from /login and
        /admin-invite — the two screens that are reached without a session and
        where a "your session ended" redirect would be a loop.
      */}
      <SessionGuard />
    </div>
  );
}

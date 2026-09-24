'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { NavIcon } from '../components/nav-icon';
import { Sidebar } from '../components/sidebar';
import type { AdminAccountSummary } from '../lib/admin-account';
import type { NavGroup } from '../lib/nav';
import { Topbar } from '../components/topbar';
import { SessionGuard } from './session/session-guard';

type AdminShellProps = {
  children: ReactNode;
  /**
   * The sidebar rows this session may open, filtered on the server. An empty
   * list is a signed-out visitor (or one whose session just expired), and the
   * shell renders the page without navigation rather than with rows that would
   * all refuse.
   */
  navGroups: NavGroup[];
  /** The sidebar's account block, from the same permissions answer; null when signed out. */
  account: AdminAccountSummary | null;
};

const DESKTOP_QUERY = '(min-width: 1024px)';
const SIDEBAR_ID = 'admin-sidebar';

/**
 * Where the icon-mode choice is kept: this browser's storage and nowhere else.
 *
 * It is a preference about a sidebar's width, so it is not worth a server
 * round trip — and not worth a failure either. Storage can be missing or throw
 * (private windows, blocked site data), and then the menu is simply wide.
 */
const RAIL_STORAGE_KEY = 'taktick-admin:sidebar-rail';

function readRailPreference(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRailPreference(rail: boolean) {
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, rail ? '1' : '0');
  } catch {
    // Not remembered; the choice still holds for this page view.
  }
}

export function AdminShell({ children, navGroups, account }: AdminShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * Icon mode as the operator chose it, and whether the viewport is wide
   * enough for it to apply. Both start false so the server's HTML and the first
   * client render agree; the stored choice is read after hydration.
   */
  const [railPreferred, setRailPreferred] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const rail = railPreferred && isDesktop;
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
  const toggleRail = useCallback(() => {
    setRailPreferred((current) => {
      writeRailPreference(!current);
      return !current;
    });
  }, []);
  const expandRail = useCallback(() => {
    writeRailPreference(false);
    setRailPreferred(false);
  }, []);

  useEffect(() => {
    setRailPreferred(readRailPreference());
  }, []);

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
      setIsDesktop(query.matches);
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
    <div className={['admin-shell', sidebarOpen ? 'is-sidebar-open' : '', rail ? 'is-rail' : ''].filter(Boolean).join(' ')}>
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
            <NavIcon name="close" size={18} />
          </button>
        </div>
        <Sidebar
          groups={navGroups}
          account={account}
          rail={rail}
          onToggleRail={toggleRail}
          onExpandRail={expandRail}
          onNavigate={closeSidebar}
        />
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
          groups={navGroups}
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

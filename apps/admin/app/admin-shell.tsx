'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '../components/sidebar';
import { Topbar } from '../components/topbar';
import { SessionGuard } from './session/session-guard';

type AdminShellProps = {
  children: ReactNode;
};

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (pathname === '/login' || pathname === '/admin-invite') {
    return <>{children}</>;
  }

  return (
    <div className={sidebarOpen ? 'admin-shell is-sidebar-open' : 'admin-shell'}>
      <aside className="admin-sidebar" aria-label="Birincil navigasyon">
        <Sidebar onNavigate={closeSidebar} />
      </aside>

      <button
        type="button"
        className="admin-sidebar-backdrop"
        aria-label="Menüyü kapat"
        onClick={closeSidebar}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <div className="admin-main">
        <Topbar onToggleSidebar={toggleSidebar} />
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

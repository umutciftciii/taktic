'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';

/**
 * The public header's navigation, folded behind one button on a narrow screen.
 *
 * On a desktop the header is a single row — logo, links, account actions — and
 * this component is invisible: the wrapper and the panel are `display:
 * contents`, the toggle is `display: none`, and the links sit in the row exactly
 * where the server put them. Below 900px that row no longer fits (the four
 * links alone are ~350px), and the header used to answer by wrapping into three
 * rows that pushed every page's own content a quarter of the screen down. There
 * the toggle appears and the links drop into a panel under the header.
 *
 * It is a disclosure, not a modal: the panel opens in the flow under the
 * header, nothing behind it is covered or made inert, so there is no focus trap
 * and no scroll lock to manage. What it does own is the keyboard contract a
 * disclosure is expected to keep — Escape closes and returns focus to the
 * toggle, a click outside closes, following a link closes, and crossing into
 * the desktop layout closes so no open flag outlives its own button.
 *
 * The links are `children`: server-rendered and passed through, so nothing
 * about who is signed in moved into the browser bundle. This component holds
 * one boolean.
 */

const DESKTOP_QUERY = '(min-width: 900px)';

export function SiteMenu({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  // A navigation closes the menu; the destination is what was asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => {
      if (query.matches) setOpen(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /**
   * A link inside the panel closes it even when it does not change the path —
   * "Nasıl çalışır" on the home page is only a hash, and `pathname` would not
   * notice it.
   */
  const onPanelClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('a')) close();
  };

  return (
    <div ref={rootRef} className={open ? 'lp-menu is-open' : 'lp-menu'}>
      <button
        ref={toggleRef}
        type="button"
        className="lp-menu-toggle"
        data-testid="site-menu-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lp-menu-toggle-icon" aria-hidden="true">
          {open ? '✕' : '☰'}
        </span>
        <span className="lp-menu-toggle-text">Menü</span>
      </button>

      {/*
        Not a <nav>: the <nav> landmark is inside it, server-rendered, and the
        same element on every width.
      */}
      <div id={panelId} className="lp-menu-panel" onClick={onPanelClick}>
        {children}
      </div>
    </div>
  );
}

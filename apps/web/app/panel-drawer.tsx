'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * The mobile frame shared by the customer and provider panels.
 *
 * Both panels are server components: they know the signed-in account, its
 * counters and its credit balance, and none of that belongs in the browser.
 * What they could not do is hold the one piece of state a small screen needs —
 * whether the navigation is open — so the sidebar used to be a full-width block
 * stacked on top of the page, and the screen the person actually asked for
 * started below eight nav items and a credit box.
 *
 * This component is the missing half. It owns nothing but the open flag and the
 * keyboard contract that comes with it; the panels still render their own
 * sidebar and topbar and pass them in, so nothing about what they display moved
 * into the client bundle.
 *
 * Below 1024px the aside becomes an off-canvas drawer. It is hidden with
 * `visibility` rather than a class the assistive tree cannot see, which is what
 * keeps a closed drawer out of the tab order without an `inert` attribute that
 * would have to differ between the server render and the first client one.
 */

const DESKTOP_QUERY = '(min-width: 1024px)';

type PanelDrawerProps = {
  /** Keeps each panel's existing class names — no styles were renamed. */
  prefix: 'pdash' | 'cdash';
  /** Accessible name for the navigation landmark. */
  navLabel: string;
  /** Shown beside the toggle on small screens, where the sidebar brand is off-canvas. */
  title: string;
  sidebar: ReactNode;
  topbar: ReactNode;
  children: ReactNode;
};

export function PanelDrawer({
  prefix,
  navLabel,
  title,
  sidebar,
  topbar,
  children,
}: PanelDrawerProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Whether the drawer was open a render ago. Focus is only moved on the
   * transition, so a re-render for any other reason does not steal it back from
   * whatever the person is using inside the drawer.
   */
  const wasOpen = useRef(false);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  const sidebarId = `${prefix}-drawer`;

  // A navigation closes the drawer: the destination is what was asked for, and
  // arriving behind the menu that requested it is never what was meant.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  /**
   * Crossing into the desktop layout closes it too. The toggle is display:none
   * there, so an open flag left behind would be a drawer nobody could shut.
   */
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => {
      if (query.matches) setOpen(false);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // Escape closes, and the page behind the drawer does not scroll while it is
  // open — the two things a drawer is expected to do and neither of which CSS
  // can do on its own.
  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }

      if (event.key !== 'Tab') return;

      // Keep Tab inside the drawer while it covers the page; without this the
      // focus ring walks onto the content behind the backdrop, which is both
      // invisible and inert to a pointer.
      const aside = asideRef.current;
      if (!aside) return;

      const focusable = aside.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !aside.contains(active))) {
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
  }, [open, close]);

  // Focus enters the drawer when it opens and returns to the toggle when it
  // closes, so a keyboard never has to walk back through the whole page.
  useEffect(() => {
    if (open && !wasOpen.current) {
      closeRef.current?.focus();
    } else if (!open && wasOpen.current) {
      toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div className={open ? `${prefix}-shell is-drawer-open` : `${prefix}-shell`}>
      <aside
        ref={asideRef}
        id={sidebarId}
        className={`${prefix}-sidebar`}
        aria-label={navLabel}
      >
        <div className="panel-drawer-head">
          <button
            ref={closeRef}
            type="button"
            className="panel-drawer-close"
            onClick={close}
            aria-label="Menüyü kapat"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {sidebar}
      </aside>

      {/*
        Only in the tree while it can be used. A permanently mounted backdrop
        with tabIndex -1 is still an element a screen reader walks past on every
        screen, and there is nothing to say about it when the drawer is shut.
      */}
      {open ? (
        <button
          type="button"
          className="panel-drawer-backdrop"
          aria-label="Menüyü kapat"
          onClick={close}
        />
      ) : null}

      <div className={`${prefix}-main`}>
        <div className={`${prefix}-topbar`}>
          <button
            ref={toggleRef}
            type="button"
            className="panel-drawer-toggle"
            data-testid="panel-drawer-toggle"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={sidebarId}
            aria-label={open ? 'Menüyü kapat' : 'Menüyü aç'}
          >
            <span aria-hidden="true">☰</span>
          </button>

          <span className="panel-drawer-title">{title}</span>

          {topbar}
        </div>

        {children}
      </div>
    </div>
  );
}

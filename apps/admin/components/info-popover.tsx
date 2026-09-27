'use client';

import { usePathname } from 'next/navigation';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { infoPopoverStore } from '../lib/info-popover-store';

/** Space kept between an open panel and the window edge. */
const EDGE_MARGIN = 12;

/**
 * The ⓘ next to a heading or a filter label: the design's replacement for a
 * right-hand explanation column.
 *
 * A disclosure, not a tooltip — the text is often the one thing an operator
 * has to know before acting ("bu liste silinemez"), so it opens on a click or
 * Enter and stays open until dismissed:
 *
 * - The trigger carries `aria-expanded` and `aria-controls`; the panel is in
 *   the DOM from the first render (`hidden` while closed), so the reference is
 *   never dangling.
 * - Only one is open on a screen at a time (`infoPopoverStore`); clicking the
 *   open one again closes it.
 * - Esc closes it and puts focus back on the trigger; a pointer press outside
 *   it, moving keyboard focus elsewhere, or navigating to another route closes
 *   it too.
 * - An open panel is nudged back inside the window, so a trigger near the
 *   right edge of a 320px phone does not widen the page. The nudge moves the
 *   box itself (`left`), not a transform of it: a transformed box still
 *   widens the document by where it was laid out.
 */
export function InfoPopover({
  label,
  children,
  size = 'md',
  testId,
}: {
  /** The trigger's accessible name — a question, e.g. "Bu ekran ne işe yarar?". */
  label: string;
  children: ReactNode;
  size?: 'md' | 'sm';
  testId?: string;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  const openId = useSyncExternalStore(infoPopoverStore.subscribe, infoPopoverStore.get, () => null);
  const open = openId === id;

  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  const pathname = usePathname();
  const renderedPath = useRef(pathname);
  useEffect(() => {
    if (renderedPath.current === pathname) return;
    renderedPath.current = pathname;
    infoPopoverStore.close(id);
  }, [pathname, id]);

  useEffect(() => () => infoPopoverStore.close(id), [id]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      infoPopoverStore.close(id);
      triggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) infoPopoverStore.close(id);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, id]);

  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    let dx = 0;
    if (rect.right > viewport - EDGE_MARGIN) dx = viewport - EDGE_MARGIN - rect.right;
    if (rect.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - rect.left;
    setShift(dx);
  }, [open]);

  function onBlur(event: FocusEvent<HTMLSpanElement>) {
    // Keyboard focus moved to something outside. A pointer press is handled
    // above; `relatedTarget` is null then, and the panel stays open.
    const next = event.relatedTarget as Node | null;
    if (next && !wrapperRef.current?.contains(next)) infoPopoverStore.close(id);
  }

  return (
    <span
      ref={wrapperRef}
      className={size === 'sm' ? 'info-popover is-sm' : 'info-popover'}
      onBlur={onBlur}
      data-testid={testId}
    >
      <button
        ref={triggerRef}
        type="button"
        className="info-popover-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => infoPopoverStore.toggle(id)}
        data-testid="info-popover-trigger"
      >
        <span aria-hidden="true">i</span>
      </button>
      <span
        ref={panelRef}
        id={panelId}
        className="info-popover-panel"
        hidden={!open}
        style={shift ? { left: `${shift}px` } : undefined}
        data-testid="info-popover-panel"
      >
        {children}
      </span>
    </span>
  );
}

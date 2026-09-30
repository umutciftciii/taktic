import type { KeyboardEvent } from 'react';

/**
 * Arrow-key movement for a small in-page `role="tablist"` (Faz 4).
 *
 * A tablist promises the ARIA tabs keyboard model: one tab in the Tab order
 * (the selected one — give the others `tabIndex={-1}`), and ←/→, Home and
 * End to move between them. Moving selects, as the two admin tablists
 * (credit operation type, ledger filter) switch in place and cost nothing.
 *
 * Put it on the tablist's `onKeyDown`; `select(index)` is the screen's own
 * setter. Focus follows the new tab.
 */
export function handleTablistKeyDown(event: KeyboardEvent<HTMLElement>, select: (index: number) => void): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLElement);
  if (current === -1 || tabs.length === 0) return;

  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (current + 1) % tabs.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (current - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  select(next);
  tabs[next]?.focus();
}

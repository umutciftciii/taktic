import type { NavIconName } from '../lib/nav';

/**
 * The shell's line icons, inline.
 *
 * The paths are the design handoff's own (drawn after Lucide, ISC). Inline
 * rather than an icon package: the shell needs a dozen glyphs, and a
 * dependency for a dozen paths is a lockfile change with nothing to show for
 * it. Every icon is decorative — the control it sits in carries the name — so
 * each one is `aria-hidden` and never focusable.
 */
const PATHS: Record<NavIconName | 'chevronDown' | 'chevronRight' | 'panel' | 'menu' | 'close', string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  file: 'M5 3h9l5 5v13H5zM14 3v5h5M9 13h6M9 17h4',
  tag: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
  users:
    'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8M22 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  wallet: 'M3 6h18v12H3zM3 11h18M16 15h2',
  store: 'M3 9l2-5h14l2 5M4 9h16v11H4zM9 20v-6h6v6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  settings: 'M4 21v-6M4 11V3M12 21v-9M12 8V3M20 21v-4M20 13V3M1 15h6M9 8h6M17 17h6',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6zM9 12l2 2 4-4',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  panel: 'M3 3h18v18H3zM9 3v18',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M6 6l12 12M18 6L6 18',
};

export type ShellIconName = keyof typeof PATHS;

type NavIconProps = {
  name: ShellIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

export function NavIcon({ name, size = 17, strokeWidth = 1.7, className }: NavIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * The design's four badge pairs, as the class names this panel already uses.
 * Existing mappings (`statusBadgeClass`, `notificationStatusBadgeClass`, …)
 * keep returning these same classes, so a screen can move to `<Badge>` without
 * any badge changing colour.
 */
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'badge badge-muted',
  success: 'badge badge-good',
  warning: 'badge badge-warn',
  danger: 'badge badge-bad',
};

export function badgeClass(tone: BadgeTone): string {
  return TONE_CLASS[tone];
}

export function Badge({
  tone = 'neutral',
  children,
  testId,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span className={TONE_CLASS[tone]} data-testid={testId}>
      {children}
    </span>
  );
}

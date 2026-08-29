'use client';

import type { ReactNode } from 'react';
import { announceSessionEnded } from './session-channel';

/**
 * The submit button of a logout form, with one addition: it tells this
 * application's other tabs before the form goes.
 *
 * Without it, a second tab stays on a signed-in screen until its own next poll
 * notices — up to half a minute of a page that looks live and is not. The
 * server-side revoke is what makes the session actually gone; this only closes
 * the window in which the other tabs have not heard yet.
 *
 * It never prevents the submit. If the announcement fails — an old browser, a
 * closed channel — the form still posts and the session still ends.
 */
export function LogoutButton({
  className,
  children,
  testId,
}: {
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      data-testid={testId}
      onClick={() => {
        announceSessionEnded();
      }}
    >
      {children}
    </button>
  );
}

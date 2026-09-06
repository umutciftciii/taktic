'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isPanelRoute } from '../lib/panel-routes';

/**
 * The public header and footer, on the screens that are theirs.
 *
 * The root layout is the only layout this app has, so it wraps the panel
 * screens as well as the public ones. It used to hand every page a header and
 * let CSS take it back on a panel route, which left the header's account menu
 * and its logout button in the document as a second, 0×0 copy of the panel's
 * own — see `lib/panel-routes.ts` for what that cost. This gate is where the
 * decision is made once instead, for both pieces of chrome and both panels.
 *
 * A client component for one reason: `usePathname` is the only way a layout can
 * learn which route it is serving. It reads the same value while the server
 * renders and while the browser hydrates, so the header is absent from the
 * first byte rather than removed afterwards, and it comes back on a client-side
 * navigation out of the panel without a round trip.
 *
 * `children` is whatever the layout already built — server components, passed
 * through untouched. Nothing about the header moved into the browser bundle.
 */
export function PublicChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isPanelRoute(pathname)) {
    return null;
  }

  return <>{children}</>;
}

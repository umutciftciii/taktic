'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { recoverFromStaleAction } from '../lib/stale-action-recovery';

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Route-level error boundary.
 *
 * Backend messages are intentionally not rendered: admin API errors can quote
 * internal identifiers and constraint text. The digest ties the screen to the
 * full server-side log entry.
 *
 * The one failure that is not worth showing anybody is a Server Action id from
 * a previous `next dev` compile — see lib/stale-action-recovery. It is still
 * logged; it just reloads the page rather than leaving a dead screen behind.
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Unhandled route error', error.digest ?? '(no digest)');
    recoverFromStaleAction(error);
  }, [error]);

  return (
    <main>
      <div className="table-card" style={{ padding: 28, textAlign: 'center' }}>
        <h1 className="page-title" style={{ marginTop: 0 }}>Bir şeyler ters gitti</h1>
        <p className="muted">
          İşlem tamamlanamadı. Tekrar deneyebilir veya dashboard'a dönebilirsiniz.
        </p>
        {error.digest ? (
          <p className="muted" style={{ fontSize: 12 }}>
            Destek referansı: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn btn-primary btn-sm" type="button" onClick={reset}>
            Tekrar dene
          </button>
          <Link className="btn btn-ghost btn-sm" href="/">
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}

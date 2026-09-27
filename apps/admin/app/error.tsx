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
      <section className="system-state" aria-labelledby="route-error-title">
        <p className="system-state-kicker">Hata</p>
        <h1 id="route-error-title" className="system-state-title">
          Bir şeyler ters gitti
        </h1>
        <p className="system-state-body">
          İşlem tamamlanamadı. Tekrar deneyebilir veya dashboard'a dönebilirsiniz.
        </p>
        {error.digest ? (
          <p className="system-state-ref">
            Destek referansı: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className="system-state-actions">
          <button className="btn btn-primary btn-sm" type="button" onClick={reset}>
            Tekrar dene
          </button>
          <Link className="btn btn-secondary btn-sm" href="/">
            Dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}

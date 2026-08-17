'use client';

import Link from 'next/link';
import { useEffect } from 'react';

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
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Unhandled route error', error.digest ?? '(no digest)');
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

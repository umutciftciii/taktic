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
 * Only the digest is surfaced — upstream API messages can carry internal
 * details, and Next already logs the full error server-side under that digest.
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Unhandled route error', error.digest ?? '(no digest)');
  }, [error]);

  return (
    <main>
      <div className="page-narrow">
        <span className="kicker">Hata</span>
        <h1 className="page-title">Bir şeyler ters gitti</h1>
        <p className="page-subtitle">
          İşleminiz tamamlanamadı. Tekrar deneyebilir veya ana sayfaya dönebilirsiniz.
        </p>
        {error.digest ? (
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            Destek referansı: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className="inline-actions" style={{ marginTop: 24 }}>
          <button className="btn btn-primary" type="button" onClick={reset}>
            Tekrar dene
          </button>
          <Link className="btn btn-secondary" href="/">
            Ana sayfa
          </Link>
        </div>
      </div>
    </main>
  );
}

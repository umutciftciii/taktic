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
        <section className="card" style={{ margin: 0, textAlign: 'center', padding: 32 }}>
          <span className="badge badge-warn" style={{ fontSize: 13, padding: '8px 14px' }}>Hata</span>
          <h1 className="page-title" style={{ marginTop: 14 }}>Bir şeyler ters gitti</h1>
          <p className="muted">
            İşleminiz tamamlanamadı. Tekrar deneyebilir veya ana sayfaya dönebilirsiniz.
          </p>
          {error.digest ? (
            <p className="muted" style={{ fontSize: 12 }}>
              Destek referansı: <code>{error.digest}</code>
            </p>
          ) : null}
          <div className="inline-actions" style={{ justifyContent: 'center', marginTop: 18 }}>
            <button className="btn btn-primary" type="button" onClick={reset}>
              Tekrar dene
            </button>
            <Link className="btn btn-ghost" href="/">Ana sayfa</Link>
          </div>
        </section>
      </div>
    </main>
  );
}

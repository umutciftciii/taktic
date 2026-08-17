'use client';

import { useEffect } from 'react';

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Last-resort boundary: catches failures in the root layout itself, where the
 * normal error.tsx cannot render because there is no layout around it.
 * Styles are inline for the same reason — globals.css may not have loaded.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error('Unhandled application error', error.digest ?? '(no digest)');
  }, [error]);

  return (
    <html lang="tr">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#f8fafc',
          color: '#0f172a',
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Bir şeyler ters gitti</h1>
          <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
            Uygulama beklenmedik bir hatayla karşılaştı. Lütfen tekrar deneyin.
          </p>
          {error.digest ? (
            <p style={{ color: '#94a3b8', fontSize: 12 }}>
              Destek referansı: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '10px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#2563eb',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Tekrar dene
          </button>
        </div>
      </body>
    </html>
  );
}

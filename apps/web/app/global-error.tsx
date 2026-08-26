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
          fontFamily: 'Archivo, system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#f3f2f2',
          color: '#201e1d',
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Bir şeyler ters gitti</h1>
          <p style={{ color: '#605d5d', fontSize: 14, lineHeight: 1.6 }}>
            Uygulama beklenmedik bir hatayla karşılaştı. Lütfen tekrar deneyin.
          </p>
          {error.digest ? (
            <p style={{ color: '#7d7979', fontSize: 12 }}>
              Destek referansı: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '10px 18px',
              borderRadius: 0,
              border: 'none',
              background: '#ec3013',
              color: '#f3f2f2',
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

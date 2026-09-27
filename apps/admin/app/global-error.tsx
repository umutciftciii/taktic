'use client';

import { useEffect } from 'react';
import { recoverFromStaleAction } from '../lib/stale-action-recovery';

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Last-resort boundary for failures in the root layout itself. Inline styles
 * because the admin stylesheet may not have loaded at this point — which is
 * also why the design tokens are repeated here as literal values (ground
 * #f3f2f2, ink #201e1d, accent #ec3013) rather than read from globals.css.
 *
 * It carries the same stale-Server-Action recovery as the route boundary: the
 * logout form lives in the topbar, which is part of the layout, so a stale id
 * posted from there surfaces here rather than there.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error('Unhandled application error', error.digest ?? '(no digest)');
    recoverFromStaleAction(error);
  }, [error]);

  return (
    <html lang="tr">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#f3f2f2',
          color: '#201e1d',
        }}
      >
        <div
          style={{
            maxWidth: 420,
            padding: 32,
            textAlign: 'center',
            background: '#ffffff',
            border: '1px solid #d7d3d3',
            borderTop: '2px solid #201e1d',
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Bir şeyler ters gitti</h1>
          <p style={{ color: '#605d5d', fontSize: 14, lineHeight: 1.6 }}>
            Yönetim paneli beklenmedik bir hatayla karşılaştı. Lütfen tekrar deneyin.
          </p>
          {error.digest ? (
            <p style={{ color: '#605d5d', fontSize: 12 }}>
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

'use client';

import { formatDateTime } from '@taktic/shared';
import { useActionState } from 'react';
import { createCustomerActivationLinkAction } from '../actions';
import { ACTIVATION_LINK_IDLE } from '../activation-link-state';

/**
 * Issues a password-set link and shows it to the operator once.
 *
 * The link is a live credential: whoever opens it can set the account's
 * password for the next 72 hours. It used to come back as a query parameter
 * (`?activationUrl=…`), which left it in the browser history, in any access
 * log in between, and in the `Referer` of the next page opened. Here it lives
 * only in this component's action state. It is shown in the response to the
 * button press and is gone after a navigation or a refresh.
 *
 * It still works without JavaScript: `useActionState` forms submit normally
 * and React renders the returned state on the server.
 */
export function ActivationLinkForm({ customerId }: { customerId: string }) {
  const [state, submit, pending] = useActionState(
    createCustomerActivationLinkAction,
    ACTIVATION_LINK_IDLE,
  );

  return (
    <>
      <form action={submit}>
        <input type="hidden" name="customerId" value={customerId} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          Aktivasyon linki oluştur
        </button>
      </form>

      {state.kind === 'error' ? (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.25)',
            color: 'rgb(153, 27, 27)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {state.message}
        </div>
      ) : null}

      {state.kind === 'issued' ? (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Aktivasyon bağlantısı oluşturuldu. Bu bağlantı 72 saat geçerlidir.
          </div>
          <code
            data-testid="customer-activation-url"
            style={{
              display: 'block',
              padding: 10,
              background: 'var(--surface-soft, #f3f4f6)',
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              wordBreak: 'break-all',
            }}
          >
            {state.activationUrl}
          </code>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Son geçerlilik: {formatDateTime(state.expiresAt)}
          </div>
        </div>
      ) : null}
    </>
  );
}

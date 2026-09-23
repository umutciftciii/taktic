'use client';

import { useActionState } from 'react';
import { revealBusinessRegistrationAction, type RawRegistrationState } from './registration-actions';

const IDLE: RawRegistrationState = { status: 'idle' };

/**
 * "Ham değeri göster" (CMP-006 PR-C). Rendered only for an operator holding
 * PROVIDER_REGISTRATION_READ_SENSITIVE; every press is one audited read.
 */
export function RawRegistrationReveal({ providerId }: { providerId: string }) {
  const [state, submit, pending] = useActionState(revealBusinessRegistrationAction, IDLE);

  if (state.status === 'shown') {
    return (
      <dl className="meta-row" data-testid="registration-raw">
        <dt>Kayıt numarası (ham)</dt>
        <dd data-testid="registration-raw-number">{state.registrationNumber ?? '—'}</dd>
        <dt>Eski vergi numarası (ham)</dt>
        <dd data-testid="registration-raw-legacy">{state.legacyTaxNumber ?? '—'}</dd>
      </dl>
    );
  }

  return (
    <form action={submit} className="inline-actions" style={{ marginTop: 8 }}>
      <input type="hidden" name="providerId" value={providerId} />
      <button className="btn btn-secondary btn-sm" type="submit" disabled={pending} data-testid="registration-reveal">
        Ham değeri göster
      </button>
      <span className="muted" style={{ fontSize: 12 }}>
        Her görüntüleme kimin, ne zaman baktığıyla kayıt altına alınır.
      </span>
      {state.status === 'error' ? (
        <div className="notice notice-error" role="alert">
          {state.message}
        </div>
      ) : null}
    </form>
  );
}

'use client';

import { useActionState, useState } from 'react';
import {
  INCIDENT_RESPONSE_MAX_LENGTH,
  INCIDENT_RESPONSE_MIN_LENGTH,
} from '../../../../../lib/provider-incidents';
import { submitIncidentResponseAction, type IncidentResponseFormState } from './actions';

/**
 * The provider's response composer. Rendered only while the API says
 * `canRespond`; the API checks it again on submit.
 */
export function IncidentResponseForm({ providerId, incidentId }: { providerId: string; incidentId: string }) {
  const [state, formAction, pending] = useActionState<IncidentResponseFormState, FormData>(
    submitIncidentResponseAction,
    { status: 'idle' },
  );
  const [text, setText] = useState(state.responseText ?? '');
  const length = text.trim().length;
  const tooShort = length < INCIDENT_RESPONSE_MIN_LENGTH;

  return (
    <form className="pdash-form" action={formAction} data-testid="incident-response-form">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="incidentId" value={incidentId} />

      <label className="pdash-form-row" htmlFor="incident-response-input">
        <span>Yanıtınız *</span>
        <textarea
          id="incident-response-input"
          name="responseText"
          rows={6}
          required
          minLength={INCIDENT_RESPONSE_MIN_LENGTH}
          maxLength={INCIDENT_RESPONSE_MAX_LENGTH}
          placeholder="Ne olduğunu kendi açınızdan kısaca anlatın."
          aria-describedby="incident-response-count"
          data-testid="incident-response-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <small id="incident-response-count" aria-live="polite" data-testid="incident-response-count">
          {text.length}/{INCIDENT_RESPONSE_MAX_LENGTH} karakter
          {tooShort ? ` · en az ${INCIDENT_RESPONSE_MIN_LENGTH} karakter` : ''}
        </small>
      </label>

      <p className="pdash-form-hint">
        Yanıtınız bir kez gönderilir ve sonradan değiştirilemez. Yanıtınıza telefon, e-posta ya
        da adres yazmayın.
      </p>

      {state.status === 'error' && state.message ? (
        <p className="pdash-notice pdash-notice-error" role="alert" data-testid="incident-response-error">
          {state.message}
        </p>
      ) : null}

      <div className="pdash-actions" style={{ justifyContent: 'flex-end' }}>
        <button
          type="submit"
          className="pdash-btn pdash-btn-primary"
          data-testid="incident-response-submit"
          disabled={pending}
        >
          {pending ? 'Gönderiliyor…' : 'Yanıtı gönder'}
        </button>
      </div>
    </form>
  );
}

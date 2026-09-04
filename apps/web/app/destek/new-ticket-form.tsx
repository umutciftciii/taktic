'use client';

import { useActionState, useState } from 'react';
import {
  SUPPORT_TICKET_MESSAGE_MAX_LENGTH,
  SUPPORT_TICKET_SUBJECT_MAX_LENGTH,
} from '@taktic/shared';
import { createSupportTicketAction, type SupportTicketFormState } from './actions';

/**
 * The form that opens a ticket.
 *
 * A plain form posting a server action, enhanced rather than replaced by this
 * component: the two counters and the pending label are what the client adds,
 * and with scripting off the ticket is still opened by the same action.
 *
 * The two `maxLength` attributes carry the same numbers the API enforces —
 * both sides read `packages/shared/limits.json` — so the browser can never stop
 * somebody the server would have accepted, or accept text the counter has
 * already reported as over the line.
 */
export function NewTicketForm() {
  const [state, formAction, pending] = useActionState<SupportTicketFormState, FormData>(
    createSupportTicketAction,
    { status: 'idle' },
  );

  const [subject, setSubject] = useState(state.subject ?? '');
  const [body, setBody] = useState(state.body ?? '');

  const subjectRemaining = SUPPORT_TICKET_SUBJECT_MAX_LENGTH - subject.length;
  const bodyRemaining = SUPPORT_TICKET_MESSAGE_MAX_LENGTH - body.length;

  return (
    <form className="cdash-account-form" action={formAction} data-testid="support-new-form">
      {/*
        The refusal is announced rather than only drawn: somebody who submitted
        with the keyboard is not necessarily looking at the top of the form.
      */}
      {state.status === 'error' && state.message ? (
        <div className="notice cdash-notice-error" role="alert" data-testid="support-form-error">
          <span>{state.message}</span>
        </div>
      ) : null}

      <label className="field" htmlFor="support-subject">
        <span className="field-label">Konu *</span>
        <input
          id="support-subject"
          className="field-control"
          name="subject"
          type="text"
          required
          maxLength={SUPPORT_TICKET_SUBJECT_MAX_LENGTH}
          autoComplete="off"
          data-testid="support-subject-input"
          aria-describedby="support-subject-count"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <small className="help-text" id="support-subject-count" aria-live="polite">
          {subjectRemaining} karakter kaldı
        </small>
      </label>

      <label className="field" htmlFor="support-message">
        <span className="field-label">Mesajınız *</span>
        <textarea
          id="support-message"
          className="msg-composer-input"
          name="message"
          rows={6}
          required
          maxLength={SUPPORT_TICKET_MESSAGE_MAX_LENGTH}
          placeholder="Yaşadığınız sorunu olabildiğince açık anlatın."
          data-testid="support-message-input"
          aria-describedby="support-message-count"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <small className="help-text" id="support-message-count" aria-live="polite">
          {bodyRemaining} karakter kaldı
        </small>
      </label>

      <div className="inline-actions">
        <button
          className="cdash-btn cdash-btn-primary"
          type="submit"
          data-testid="support-submit"
          disabled={pending || subject.trim().length === 0 || body.trim().length === 0}
        >
          {pending ? 'Gönderiliyor…' : 'Destek talebi oluştur'}
        </button>
      </div>
    </form>
  );
}

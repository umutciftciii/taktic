'use client';

import { useActionState, useState } from 'react';
import { SUPPORT_TICKET_MESSAGE_MAX_LENGTH } from '@taktic/shared';
import { replySupportTicketAction, type SupportTicketFormState } from './actions';

/**
 * The composer on an open ticket.
 *
 * Rendered only where the API said the ticket still takes a message — see
 * `canReply` — so a resolved or closed ticket shows an explanation instead of a
 * box that would be refused. The server checks it again regardless, because a
 * composer that is not on screen is not a rule.
 */
export function ReplyForm({ ticketId }: { ticketId: string }) {
  const [state, formAction, pending] = useActionState<SupportTicketFormState, FormData>(
    replySupportTicketAction,
    { status: 'idle' },
  );

  const [body, setBody] = useState(state.body ?? '');
  const remaining = SUPPORT_TICKET_MESSAGE_MAX_LENGTH - body.length;

  return (
    <form className="msg-composer" action={formAction} data-testid="support-reply-form">
      <input type="hidden" name="ticketId" value={ticketId} />

      <label className="cdash-visually-hidden" htmlFor="support-reply-body">
        Destek talebine mesajınız
      </label>
      <textarea
        id="support-reply-body"
        name="body"
        className="msg-composer-input"
        data-testid="support-reply-input"
        rows={4}
        required
        maxLength={SUPPORT_TICKET_MESSAGE_MAX_LENGTH}
        placeholder="Mesajınızı yazın…"
        aria-describedby="support-reply-count"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />

      <div className="msg-composer-footer">
        <span
          className="msg-composer-count"
          id="support-reply-count"
          data-testid="support-reply-remaining"
          aria-live="polite"
        >
          {remaining} karakter kaldı
        </span>
        <button
          className="cdash-btn cdash-btn-primary"
          type="submit"
          data-testid="support-reply-send"
          disabled={pending || body.trim().length === 0}
        >
          {pending ? 'Gönderiliyor…' : 'Gönder'}
        </button>
      </div>

      {state.status === 'error' && state.message ? (
        <p className="msg-composer-error" role="alert" data-testid="support-reply-error">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

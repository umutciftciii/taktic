'use client';

import { useActionState, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { formatDate } from '../../../../lib/request-formatters';
import type { CustomerServiceIssueView, ServiceIssueReason } from '../../../../lib/api';
import {
  NOTE_REQUIRED_REASONS,
  SERVICE_ISSUE_CONSEQUENCE,
  SERVICE_ISSUE_IRREVERSIBLE,
  SERVICE_ISSUE_NOTE_MAX_LENGTH,
  SERVICE_ISSUE_NOTE_MIN_LENGTH,
  SERVICE_ISSUE_REASON_LABELS,
} from '../../../../lib/service-issue';
import { reportServiceIssueAction, type ServiceIssueFormState } from './actions';

const EMPTY: ServiceIssueFormState = { error: null };

/**
 * REL-002 Faz 3 — "Hizmetle ilgili sorun bildir".
 *
 * The reasons and which of them are open come from the API (`serviceIssue`);
 * a disabled reason says from which day it opens. The idempotency key is
 * minted when the dialog opens, so a double click or a retried submission is
 * the same report, and a new opening is a new one. Before the promised start
 * day the only open reason is the provider's own cancellation, and the entry
 * point says exactly that instead of offering a form full of closed options.
 */
export function ServiceIssueDialog({
  requestId,
  view,
}: {
  requestId: string;
  view: CustomerServiceIssueView;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [key, setKey] = useState('');
  const [reason, setReason] = useState<ServiceIssueReason | ''>('');
  const [note, setNote] = useState('');
  const [state, formAction] = useActionState(reportServiceIssueAction, EMPTY);

  const onlyCancellation =
    view.availableReasons.length === 1 && view.availableReasons[0] === 'PROVIDER_CANCELLED_BEFORE_START';
  const noteRequired = reason !== '' && NOTE_REQUIRED_REASONS.has(reason);
  const noteLength = note.trim().length;
  const ready = reason !== '' && (!noteRequired || noteLength >= SERVICE_ISSUE_NOTE_MIN_LENGTH);
  const reasons = onlyCancellation
    ? view.reasons.filter((entry) => entry.reason === 'PROVIDER_CANCELLED_BEFORE_START')
    : view.reasons;

  function open() {
    setKey(crypto.randomUUID());
    setReason(onlyCancellation ? 'PROVIDER_CANCELLED_BEFORE_START' : '');
    setNote('');
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
    trigger.current?.focus();
  }

  return (
    <div className="service-issue-entry" data-testid="service-issue-entry">
      <button
        ref={trigger}
        type="button"
        className={onlyCancellation ? 'cdash-link-button' : 'cdash-btn cdash-btn-secondary'}
        onClick={open}
        data-testid="service-issue-open"
      >
        {onlyCancellation ? 'Hizmet veren işi yapamayacağını bildirdi' : 'Hizmetle ilgili sorun bildir'}
      </button>
      {onlyCancellation && view.nextOpensOn ? (
        <p className="cdash-offer-sub" data-testid="service-issue-next-opens">
          Diğer sorunları {formatDate(view.nextOpensOn)} tarihinden itibaren bildirebilirsiniz.
        </p>
      ) : null}

      <dialog
        ref={dialog}
        className="report-dialog service-issue-dialog"
        aria-labelledby={titleId}
        data-testid="service-issue-dialog"
        onClose={() => trigger.current?.focus()}
      >
        <form action={formAction} className="service-issue-form">
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="roundId" value={view.roundId ?? ''} />
          <input type="hidden" name="idempotencyKey" value={key} />
          <h2 id={titleId}>Hizmetle ilgili sorun bildir</h2>

          <fieldset className="service-issue-reasons">
            <legend>Ne oldu?</legend>
            {reasons.map((entry) => {
              const hintId = `${titleId}-${entry.reason}-hint`;
              return (
                <label
                  key={entry.reason}
                  className={`service-issue-reason${entry.available ? '' : ' is-disabled'}`}
                  data-testid={`service-issue-reason-${entry.reason}`}
                >
                  <input
                    type="radio"
                    name="reason"
                    value={entry.reason}
                    checked={reason === entry.reason}
                    disabled={!entry.available}
                    aria-disabled={!entry.available}
                    aria-describedby={entry.available ? undefined : hintId}
                    onChange={() => setReason(entry.reason)}
                  />
                  <span>{SERVICE_ISSUE_REASON_LABELS[entry.reason]}</span>
                  {!entry.available && entry.opensOn ? (
                    <span className="cdash-offer-sub" id={hintId}>
                      {formatDate(entry.opensOn)} tarihinden itibaren
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>

          <label className="field" htmlFor={`${titleId}-note`}>
            <span className="field-label">
              Açıklama {noteRequired ? '(zorunlu)' : '(isteğe bağlı)'}
            </span>
            <textarea
              id={`${titleId}-note`}
              name="note"
              rows={4}
              maxLength={SERVICE_ISSUE_NOTE_MAX_LENGTH}
              value={note}
              required={noteRequired}
              onChange={(event) => setNote(event.target.value)}
              data-testid="service-issue-note"
              placeholder={
                reason === 'PROVIDER_CANCELLED_BEFORE_START'
                  ? 'Hizmet veren işi yapamayacağını nasıl ve ne zaman bildirdi?'
                  : 'Neler yaşandığını kısaca yazın.'
              }
            />
            <span className="cdash-offer-sub" aria-live="polite">
              {noteRequired && noteLength < SERVICE_ISSUE_NOTE_MIN_LENGTH
                ? `En az ${SERVICE_ISSUE_NOTE_MIN_LENGTH} karakter (${noteLength}/${SERVICE_ISSUE_NOTE_MIN_LENGTH})`
                : `${note.length}/${SERVICE_ISSUE_NOTE_MAX_LENGTH}`}
            </span>
          </label>

          <div className="service-issue-consequence" data-testid="service-issue-consequence">
            <p>{view.consequence === 'ADMIN_REVIEW' ? SERVICE_ISSUE_CONSEQUENCE.ADMIN_REVIEW : SERVICE_ISSUE_CONSEQUENCE.REOPEN}</p>
            <p>
              <strong>{SERVICE_ISSUE_IRREVERSIBLE}</strong>
            </p>
          </div>

          {state.error ? (
            <p className="cdash-notice cdash-notice-error" role="alert" data-testid="service-issue-error">
              {state.error}
            </p>
          ) : null}

          <div className="report-dialog-actions">
            <button type="button" className="cdash-btn cdash-btn-secondary" onClick={close}>
              Vazgeç
            </button>
            <SubmitButton ready={ready && key !== ''} />
          </div>
        </form>
      </dialog>
    </div>
  );
}

function SubmitButton({ ready }: { ready: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="cdash-btn cdash-btn-primary"
      type="submit"
      disabled={!ready || pending}
      aria-disabled={!ready || pending}
      data-testid="service-issue-submit"
    >
      {pending ? 'Gönderiliyor…' : 'Bildir ve eşleşmeyi kapat'}
    </button>
  );
}

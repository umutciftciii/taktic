'use client';

import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { mintConfirmationProof } from '../lib/confirmation-proof-actions';
import { CONFIRMATION_PROOF_FIELD, type ConfirmationProofKey } from '../lib/confirmation-proof-keys';
import { shadowedFormId } from './confirm-dialog';

/** What one submission of a gated form needs confirmed, or nothing. */
export type ConfirmGateDecision = {
  /** One proof per guarded change; the action demands the same list from the stored record. */
  proofs: ConfirmationProofKey[];
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
};

type ConfirmGateProps = {
  triggerLabel: string;
  triggerClassName?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  testId?: string;
  /**
   * Reads the form as it is about to be submitted and answers which
   * confirmation this submission needs — or null when it needs none, and the
   * button submits as a plain one would.
   *
   * It is the screen's courtesy, never the rule: the server action works out
   * the same list from the stored record and refuses a submission whose
   * proofs do not cover it (`hasConfirmationProofs`).
   */
  evaluate: (form: HTMLFormElement) => ConfirmGateDecision | null;
};

/**
 * A submit button that asks first only when the submission needs it
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket A) — `ConfirmDialog` for a form
 * whose risk depends on what was typed: a package edit that changes the price
 * asks, one that fixes a typo in the description does not.
 *
 * Everything else is `ConfirmDialog`'s contract: the trigger is the form's own
 * submit button; "confirm" mints a single-use proof for each key the decision
 * names (in a handler that does not exist before hydration) and submits the
 * same form through `requestSubmit(trigger)` with them; Esc, Vazgeç and the
 * backdrop submit nothing; focus starts on Vazgeç. A click before hydration
 * or a post with JavaScript off reaches the action with no proof, and the
 * action refuses it whenever a proof was due.
 */
export function ConfirmGate({
  triggerLabel,
  triggerClassName = 'btn btn-primary',
  name,
  value,
  disabled = false,
  testId,
  evaluate,
}: ConfirmGateProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  const [decision, setDecision] = useState<ConfirmGateDecision | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [proofError, setProofError] = useState<string | null>(null);

  function onTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    const form = triggerRef.current?.form;
    if (!form) return;
    const next = evaluate(form);
    // Nothing to confirm: the click is an ordinary submit.
    if (!next) return;
    event.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setProofError(null);
    setDecision(next);
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function confirm() {
    if (confirmingRef.current || !decision) return;
    confirmingRef.current = true;
    setConfirming(true);
    setProofError(null);
    try {
      let tokens: Array<string | null>;
      try {
        tokens = await Promise.all(decision.proofs.map((key) => mintConfirmationProof(key)));
      } catch {
        tokens = [null];
      }
      if (tokens.some((token) => !token)) {
        setProofError('Onay doğrulanamadı; işlem gönderilmedi. Sayfayı yenileyip yeniden deneyin.');
        return;
      }

      const trigger = triggerRef.current;
      close();
      const form = trigger?.form;
      if (!trigger || !form) return;
      const carriers = tokens.map((token) => carryValue(form, trigger, CONFIRMATION_PROOF_FIELD, token!));
      if (shadowedFormId(form) && name) carriers.push(carryValue(form, trigger, name, value ?? ''));
      try {
        form.requestSubmit(trigger);
      } finally {
        for (const carrier of carriers) carrier.remove();
      }
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) close();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="submit"
        className={triggerClassName}
        name={name}
        value={value}
        onClick={onTriggerClick}
        disabled={pending || disabled}
        aria-disabled={pending || disabled}
        data-testid={testId}
      >
        {triggerLabel}
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClose={() => triggerRef.current?.focus()}
        // React carries a dialog's `cancel` up its own tree: inside a
        // RouteDialog (the "Yeni paket" window) Esc here would otherwise close
        // that window too, and the operator's typing with it.
        onCancel={(event) => event.stopPropagation()}
        onClick={onBackdropClick}
        data-testid={testId ? `${testId}-dialog` : undefined}
      >
        <div className="confirm-dialog-head">
          <h2 className="confirm-dialog-title" id={titleId}>
            {decision?.title ?? triggerLabel}
          </h2>
          <button type="button" className="confirm-dialog-close" aria-label="Kapat" onClick={close}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="confirm-dialog-body" id={bodyId}>
          {decision?.consequence}
          {proofError ? (
            <p className="notice notice-error" role="alert" data-testid={testId ? `${testId}-proof-error` : undefined}>
              {proofError}
            </p>
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={close}>
            Vazgeç
          </button>
          <button
            type="button"
            className={decision?.tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={confirm}
            disabled={confirming}
            aria-busy={confirming || undefined}
          >
            {decision?.confirmLabel ?? 'Onayla'}
          </button>
        </div>
      </dialog>
    </>
  );
}

function carryValue(form: HTMLFormElement, trigger: HTMLButtonElement, name: string, value: string): HTMLInputElement {
  const carrier = form.ownerDocument.createElement('input');
  carrier.type = 'hidden';
  carrier.name = name;
  carrier.value = value;
  trigger.before(carrier);
  return carrier;
}

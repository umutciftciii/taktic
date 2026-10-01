'use client';

import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { mintConfirmationProof } from '../lib/confirmation-proof-actions';
import { CONFIRMATION_PROOF_FIELD, type ConfirmationProofKey } from '../lib/confirmation-proof-keys';

type ConfirmDialogProps = {
  /** The submit button's own label, e.g. "Hesabı pasife al". */
  triggerLabel: string;
  title: string;
  /**
   * What will happen, written before it happens ("Kullanıcı bir daha giriş
   * yapamaz; açık oturumları kapanır."). The whole point of the dialog.
   */
  consequence: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for anything that cannot be undone. */
  tone?: 'danger' | 'primary';
  /** The trigger's classes; the design's destructive button by default. */
  triggerClassName?: string;
  /** Submitted with the form, like any submit button's name/value. */
  name?: string;
  value?: string;
  /**
   * Keeps the trigger closed, e.g. while a client-side call the form starts is
   * still running. A pending server action disables it on its own.
   */
  disabled?: boolean;
  /**
   * Draws the trigger as the design's switch (`Toggle`'s track and knob,
   * `role="switch"`, `aria-checked`) for a setting that asks before it moves.
   * `triggerLabel` is then the switch's accessible name, and the visible text
   * beside the track is its state.
   */
  switchChecked?: boolean;
  testId?: string;
  /**
   * Which confirmation this is (`CONFIRMATION_PROOF_KEYS`). Required: on
   * confirm the dialog asks the server for a short-lived, single-use proof
   * bound to this key and the session, and submits it with the form; the
   * form's server action refuses a submission without it. That is what makes a
   * click that beat hydration — or a post with JavaScript off — write nothing.
   */
  proof: ConfirmationProofKey;
};

/**
 * A confirmation step in front of an existing server-action form.
 *
 * It is dropped *inside* the `<form action={…}>` in place of the submit
 * button, and it changes nothing about the action: the trigger is still that
 * form's submit button. A click (or Enter in a field, which the browser turns
 * into a click on it) is stopped and the dialog opens instead; "confirm" then
 * submits the same form through `requestSubmit(trigger)`, so the button's
 * name/value, React's action and `useFormStatus` all behave exactly as if the
 * button had been pressed. Cancel, Esc and a click on the backdrop close it
 * without submitting anything. The one case where React would lose the
 * button's name/value — a field named "id" in the same form — is detected and
 * the value carried by hand (`shadowedFormId`), so the action never receives
 * a submission without it.
 *
 * Confirming is also what proves it happened: the confirm handler asks the
 * server for a single-use proof (`lib/confirmation-proof.ts`) and submits it
 * with the form in a temporary hidden field, removed again straight after.
 * The guarded server action refuses a submission without a good proof, so a
 * click before hydration — which React 19 queues and replays as a plain
 * submission — or a post with JavaScript off writes nothing.
 *
 * The dialog is a native `<dialog>` opened with `showModal()`: the rest of the
 * page is inert while it is open (the focus trap), Esc is the browser's own
 * cancel, and it is labelled by its title and described by the consequence.
 * Focus starts on the safe choice — cancel — and goes back to the trigger when
 * it closes.
 */
export function ConfirmDialog({
  triggerLabel,
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Vazgeç',
  tone = 'danger',
  triggerClassName = 'btn btn-destructive',
  name,
  value,
  disabled = false,
  switchChecked,
  testId,
  proof,
}: ConfirmDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  const [confirming, setConfirming] = useState(false);
  // The guard itself is a ref: a double press lands before React re-renders,
  // when `confirming` in the handler's closure is still false.
  const confirmingRef = useRef(false);
  const [proofError, setProofError] = useState<string | null>(null);

  function open(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    // A required field left empty is the browser's to report, before anyone
    // is asked to confirm a submission that would not go through anyway.
    const form = triggerRef.current?.form;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setProofError(null);
    dialogRef.current?.showModal();
    // Explicitly, not through `autoFocus`: React writes that attribute only in
    // server-rendered markup, so a dialog rendered on the client would open
    // with focus on its first button (×) instead of on the safe choice.
    cancelRef.current?.focus();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function confirm() {
    // One proof per press: a second click while the first is being minted
    // would otherwise submit the form twice.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    setProofError(null);
    try {
      let token: string | null = null;
      try {
        token = await mintConfirmationProof(proof);
      } catch {
        token = null;
      }
      if (!token) {
        setProofError('Onay doğrulanamadı; işlem gönderilmedi. Sayfayı yenileyip yeniden deneyin.');
        return;
      }

      const trigger = triggerRef.current;
      close();
      const form = trigger?.form;
      if (!trigger || !form) return;
      const carriers = [carryValue(form, trigger, CONFIRMATION_PROOF_FIELD, token)];
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
    // A click on the ::backdrop lands on the <dialog> element itself; clicks
    // on its content land on a child.
    if (event.target === dialogRef.current) close();
  }

  const isSwitch = switchChecked !== undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="submit"
        className={triggerClassName}
        name={name}
        value={value}
        onClick={open}
        disabled={pending || disabled}
        aria-disabled={pending || disabled}
        // A switch names what it turns on and reads its own state; the dialog
        // it opens is the consequence text, not a popup the role allows.
        role={isSwitch ? 'switch' : undefined}
        aria-checked={isSwitch ? switchChecked : undefined}
        aria-label={isSwitch ? triggerLabel : undefined}
        aria-haspopup={isSwitch ? undefined : 'dialog'}
        data-testid={testId}
      >
        {isSwitch ? (
          <>
            <span className="toggle-track" aria-hidden="true">
              <span className="toggle-knob" />
            </span>
            <span className="toggle-state" aria-hidden="true">
              {pending ? 'Kaydediliyor…' : switchChecked ? 'Açık' : 'Kapalı'}
            </span>
          </>
        ) : (
          triggerLabel
        )}
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClose={() => triggerRef.current?.focus()}
        onClick={onBackdropClick}
        data-testid={testId ? `${testId}-dialog` : undefined}
      >
        <div className="confirm-dialog-head">
          <h2 className="confirm-dialog-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="confirm-dialog-close" aria-label="Kapat" onClick={close}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="confirm-dialog-body" id={bodyId}>
          {consequence}
          {proofError ? (
            <p className="notice notice-error" role="alert" data-testid={testId ? `${testId}-proof-error` : undefined}>
              {proofError}
            </p>
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={close}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={confirm}
            disabled={confirming}
            aria-busy={confirming || undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}

/**
 * True when a control named "id" hides the form's own `id` property.
 *
 * React 19 carries the pressed button's name/value into the action's
 * FormData through a temporary input it ties to the form with
 * `form={form.id}`. A field named "id" (`<input type="hidden" name="id">`,
 * the panel's usual record id) makes `form.id` that element, the temporary
 * input points at "[object HTMLInputElement]", belongs to no form, and the
 * button's value is dropped without an error (found in Faz 3D).
 */
export function shadowedFormId(form: HTMLFormElement): boolean {
  return typeof form.id !== 'string';
}

/**
 * Puts a name/value into the form for the one synchronous submission
 * `requestSubmit` makes — React builds its FormData inside that call, and an
 * `onSubmit` handler reads it there too — then it is removed straight after.
 * Used for the confirmation proof, and for the trigger's own name/value when a
 * shadowed `form.id` would drop it.
 */
function carryValue(form: HTMLFormElement, trigger: HTMLButtonElement, name: string, value: string): HTMLInputElement {
  const carrier = form.ownerDocument.createElement('input');
  carrier.type = 'hidden';
  carrier.name = name;
  carrier.value = value;
  trigger.before(carrier);
  return carrier;
}

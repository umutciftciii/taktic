'use client';

import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

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
}: ConfirmDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();

  function open(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    // A required field left empty is the browser's to report, before anyone
    // is asked to confirm a submission that would not go through anyway.
    const form = triggerRef.current?.form;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    dialogRef.current?.showModal();
    // Explicitly, not through `autoFocus`: React writes that attribute only in
    // server-rendered markup, so a dialog rendered on the client would open
    // with focus on its first button (×) instead of on the safe choice.
    cancelRef.current?.focus();
  }

  function close() {
    dialogRef.current?.close();
  }

  function confirm() {
    const trigger = triggerRef.current;
    close();
    const form = trigger?.form;
    if (!trigger || !form) return;
    const carrier = shadowedFormId(form) && name ? carryValue(form, trigger, name, value ?? '') : null;
    try {
      form.requestSubmit(trigger);
    } finally {
      carrier?.remove();
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
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={close}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={confirm}
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
 * Puts the trigger's name/value into the form for the one synchronous
 * submission `requestSubmit` makes — React builds its FormData inside that
 * call — so that a shadowed `form.id` cannot drop it. Removed straight after.
 */
function carryValue(form: HTMLFormElement, trigger: HTMLButtonElement, name: string, value: string): HTMLInputElement {
  const carrier = form.ownerDocument.createElement('input');
  carrier.type = 'hidden';
  carrier.name = name;
  carrier.value = value;
  trigger.before(carrier);
  return carrier;
}

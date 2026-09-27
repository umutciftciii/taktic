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
 * without submitting anything.
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
    trigger?.form?.requestSubmit(trigger);
  }

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // A click on the ::backdrop lands on the <dialog> element itself; clicks
    // on its content land on a child.
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
        onClick={open}
        disabled={pending}
        aria-disabled={pending}
        aria-haspopup="dialog"
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

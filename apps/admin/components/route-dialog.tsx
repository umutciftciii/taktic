'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A record's detail/edit window that lives at a URL (`?paket=…`).
 *
 * The screen renders it only while its query parameter names a record, with
 * server-rendered contents — the same forms and server actions the screen had
 * inline before — so the window is a deep link, survives a reload, and Back
 * closes it. Closing it (×, Esc, or a "Vazgeç" link the contents carry) is a
 * navigation to `closeHref` and nothing else: no form is submitted on the way
 * out. A click on the backdrop does not close it — the window holds a form,
 * and a stray click should not throw away what was typed.
 *
 * A native `<dialog>` opened with `showModal()` after hydration: the page
 * behind it is inert, and focus starts on the first field (not on the ×,
 * which is what `showModal()` alone would pick). Because closing is a
 * navigation that unmounts the dialog, the browser has nothing to hand focus
 * back to; the dialog does it itself — to the link that opened it, found
 * again by its address when the page behind re-rendered it.
 */
export function RouteDialog({
  title,
  closeHref,
  children,
  testId,
}: {
  title: ReactNode;
  closeHref: string;
  children: ReactNode;
  testId?: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `${useId()}-title`;

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const openerHref = opener?.getAttribute('href') ?? null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      const firstField = dialog.querySelector<HTMLElement>(
        '.route-dialog-body :is(input:not([type="hidden"]), select, textarea):not([disabled])',
      );
      firstField?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
      // After the navigation has settled: the opener, or the link to the same
      // address if the page behind replaced it.
      window.requestAnimationFrame(() => {
        const target =
          opener && opener.isConnected && opener !== document.body
            ? opener
            : openerHref
              ? document.querySelector<HTMLElement>(`a[href="${CSS.escape(openerHref)}"]`)
              : null;
        target?.focus();
      });
    };
  }, []);

  function close() {
    router.replace(closeHref, { scroll: false });
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog route-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      // Esc: the browser's own cancel. Prevented so the dialog stays until the
      // navigation that closes it has replaced the URL.
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      data-testid={testId}
    >
      <div className="confirm-dialog-head">
        <h2 className="confirm-dialog-title" id={titleId}>
          {title}
        </h2>
        <button type="button" className="confirm-dialog-close" aria-label="Kapat" onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="confirm-dialog-body route-dialog-body">{children}</div>
    </dialog>
  );
}

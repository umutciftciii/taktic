'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isLeavingClick, snapshotEntries } from '../lib/dirty-form';

const DEFAULT_LEAVE_MESSAGE = 'Kaydedilmemiş değişiklikler var. Sayfadan ayrılırsanız kaybolacak. Devam edilsin mi?';

type StickyActionBarProps = {
  /** The id of the `<form>` this bar saves and watches. */
  formId: string;
  saveLabel?: string;
  resetLabel?: string;
  /** e.g. "Son değişiklik: 22 Eyl 09:14 · Ayşe Demir". */
  note?: ReactNode;
  leaveMessage?: string;
  testId?: string;
};

/**
 * The design's sticky save bar, and the "you have unsaved changes" guard.
 *
 * It sits outside the form it saves and reaches it through `form={formId}`,
 * so the form's server action is untouched: "Kaydet" is simply another submit
 * button of that form, "Vazgeç" a reset button.
 *
 * Dirty means "what the form would submit now differs from what it would
 * have submitted when it rendered" (`lib/dirty-form.ts`). While it is dirty:
 * - the bar says so in a polite live region, which a screen reader announces
 *   once rather than on every keystroke;
 * - closing or reloading the tab gets the browser's own leave-page prompt;
 * - following a link to another page asks first (`window.confirm`, which is
 *   modal and accessible by construction).
 * Submitting the form lifts the guard — the operator is saving, not leaving —
 * and a reset (including the one React performs after a successful action)
 * takes a fresh snapshot.
 */
export function StickyActionBar({
  formId,
  saveLabel = 'Değişiklikleri kaydet',
  resetLabel = 'Vazgeç',
  note,
  leaveMessage = DEFAULT_LEAVE_MESSAGE,
  testId,
}: StickyActionBarProps) {
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    const snapshot = () => snapshotEntries(new FormData(form).entries());
    let baseline = snapshot();

    const update = (next: boolean) => {
      dirtyRef.current = next;
      setDirty(next);
    };
    const recompute = () => update(snapshot() !== baseline);
    const rebase = () => {
      // `reset` fires before the fields are restored.
      window.setTimeout(() => {
        baseline = snapshot();
        submittingRef.current = false;
        update(false);
      }, 0);
    };
    const onSubmit = () => {
      submittingRef.current = true;
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current || submittingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onDocumentClick = (event: globalThis.MouseEvent) => {
      if (!dirtyRef.current || submittingRef.current) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const leaving = isLeavingClick({
        href: anchor.getAttribute('href'),
        currentHref: window.location.href,
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
        button: event.button,
        modifierKey: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
      });
      if (leaving && !window.confirm(leaveMessage)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    form.addEventListener('input', recompute);
    form.addEventListener('change', recompute);
    form.addEventListener('reset', rebase);
    form.addEventListener('submit', onSubmit);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Capture phase, so the question comes before Next's router handles the click.
    document.addEventListener('click', onDocumentClick, true);

    return () => {
      form.removeEventListener('input', recompute);
      form.removeEventListener('change', recompute);
      form.removeEventListener('reset', rebase);
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onDocumentClick, true);
    };
  }, [formId, leaveMessage]);

  return (
    <div className="sticky-action-bar" data-testid={testId} data-dirty={dirty ? 'true' : 'false'}>
      <div className="sticky-action-bar-text">
        <p className={dirty ? 'sticky-action-bar-status is-dirty' : 'sticky-action-bar-status'} role="status">
          {dirty ? 'Kaydedilmemiş değişiklikler var' : 'Değişiklik yok'}
        </p>
        {note ? <p className="sticky-action-bar-note">{note}</p> : null}
      </div>
      <div className="sticky-action-bar-actions">
        <button type="reset" form={formId} className="btn btn-secondary" disabled={!dirty}>
          {resetLabel}
        </button>
        <button type="submit" form={formId} className="btn btn-primary">
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

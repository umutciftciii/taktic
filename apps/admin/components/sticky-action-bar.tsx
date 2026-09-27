'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { applyEntries, isLeavingClick, readEntries, snapshotEntries, type FormEntries } from '../lib/dirty-form';

const DEFAULT_LEAVE_MESSAGE = 'Kaydedilmemiş değişiklikler var. Sayfadan ayrılırsanız kaybolacak. Devam edilsin mi?';

/** Marks the extra history entry that stands between a dirty form and "Geri". */
const GUARD_KEY = '__stickyActionBarGuard';

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

function isGuardState(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && (state as Record<string, unknown>)[GUARD_KEY]);
}

/**
 * The design's sticky save bar, and the "you have unsaved changes" guard.
 *
 * It sits outside the form it saves and reaches it through `form={formId}`,
 * so the form's server action is untouched: "Kaydet" is simply another submit
 * button of that form, "Vazgeç" a reset button.
 *
 * Dirty means "what the form would submit now differs from what it would
 * have submitted when it rendered" (`lib/dirty-form.ts`). While it is dirty:
 * - the bar says so in a polite live region;
 * - closing or reloading the tab gets the browser's own leave-page prompt;
 * - following a link to another page asks first (`window.confirm`);
 * - the browser's Back button asks first too. A same-URL history entry is
 *   pushed when the form turns dirty, so Back lands on it and the question is
 *   asked before the router moves; Forward entries are dropped by that push,
 *   so Forward cannot leave the page either. The entry is taken back once the
 *   form is clean again.
 *
 * A submission never switches the guard off. A server action does not unload
 * the page, so there is nothing to exempt, and a save that fails leaves the
 * operator's edits in place and still guarded:
 * - if the action throws, the fields are untouched and the form stays dirty;
 * - if the action returns and React resets the form (it does so after any
 *   action that did not throw, an error result included), the reset is
 *   compared with what was submitted. Defaults that now equal the submission
 *   mean the save landed: the form is clean. Anything else means the server
 *   kept the old values, so the submitted values are written back into the
 *   fields and the form stays dirty — nothing the operator typed is lost.
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
  const userResetRef = useRef(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    let baseline = snapshotEntries(readEntries(form));
    let isDirty = false;
    /** What the last submission sent, until the reset that follows it is judged. */
    let submitted: FormEntries | null = null;
    let guarded = false;
    let leaving = false;
    let unwinding = false;

    const setGuard = (next: boolean) => {
      if (next && !guarded) {
        window.history.pushState({ ...(window.history.state ?? {}), [GUARD_KEY]: true }, '', window.location.href);
        guarded = true;
      } else if (!next && guarded) {
        guarded = false;
        // Take our entry back, silently, if it is still the one on top.
        if (isGuardState(window.history.state)) {
          unwinding = true;
          window.history.back();
        }
      }
    };

    const update = (next: boolean) => {
      if (next === isDirty) return;
      isDirty = next;
      setDirty(next);
      setGuard(next);
    };
    const recompute = () => {
      submitted = null;
      update(snapshotEntries(readEntries(form)) !== baseline);
    };

    const onReset = () => {
      const byUser = userResetRef.current;
      userResetRef.current = false;
      const sent = submitted;
      submitted = null;
      // `reset` fires before the fields are restored.
      window.setTimeout(() => {
        const restored = snapshotEntries(readEntries(form));
        if (!byUser && sent && restored !== snapshotEntries(sent)) {
          // React reset a form whose save did not land: put the edits back.
          applyEntries(form, sent);
          baseline = restored;
          update(true);
          return;
        }
        baseline = restored;
        update(false);
      }, 0);
    };
    const onSubmit = () => {
      submitted = readEntries(form);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty || leaving) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onDocumentClick = (event: globalThis.MouseEvent) => {
      if (!isDirty) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const away = isLeavingClick({
        href: anchor.getAttribute('href'),
        currentHref: window.location.href,
        target: anchor.getAttribute('target'),
        download: anchor.hasAttribute('download'),
        button: event.button,
        modifierKey: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
      });
      if (!away) return;
      if (window.confirm(leaveMessage)) {
        leaving = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const onPopState = (event: PopStateEvent) => {
      if (unwinding) {
        // Our own cleanup of the guard entry: the page did not change.
        unwinding = false;
        event.stopImmediatePropagation();
        return;
      }
      if (!guarded || leaving) return;
      // Back from the guard entry: the URL is still this page's, so nothing
      // is lost yet. The router never hears of it.
      event.stopImmediatePropagation();
      guarded = false;
      if (window.confirm(leaveMessage)) {
        leaving = true;
        window.history.back();
      } else {
        setGuard(true);
      }
    };

    form.addEventListener('input', recompute);
    form.addEventListener('change', recompute);
    form.addEventListener('reset', onReset);
    form.addEventListener('submit', onSubmit);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Capture phase on both, so the question comes before the router acts.
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('popstate', onPopState, true);

    return () => {
      form.removeEventListener('input', recompute);
      form.removeEventListener('change', recompute);
      form.removeEventListener('reset', onReset);
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onDocumentClick, true);
      window.removeEventListener('popstate', onPopState, true);
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
        <button
          type="reset"
          form={formId}
          className="btn btn-secondary"
          disabled={!dirty}
          onClick={() => {
            userResetRef.current = true;
          }}
        >
          {resetLabel}
        </button>
        <button type="submit" form={formId} className="btn btn-primary">
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef } from 'react';

/**
 * What the provider typed into the offer form, kept across a refused submit
 * (RELEASE-GAP-001 / UAT B-04).
 *
 * A refusal comes back as a redirect to the same screen with `?offerError=…`,
 * and the form it lands on is a fresh one: price, dates and message were gone,
 * and the provider had to type everything again to fix one date. The values
 * are copied when the form is submitted and written back only when the page
 * says the submit was refused.
 *
 * Where they are kept is the tab's own `sessionStorage`, never the URL: the
 * message and the internal note are the provider's words and do not belong in
 * a link, a log line or the browser history. The copy is dropped on any visit
 * that is not a refusal and when the offer exists, and the tab takes it with it
 * when it closes.
 *
 * Only the fields the provider types. `expectedCreditCost` is the price the
 * page displayed, and after a price change it must be the new one, so it is
 * never restored.
 */
export const OFFER_DRAFT_FIELDS = [
  'priceAmount',
  'currency',
  'estimatedStartDate',
  'estimatedCompletionDate',
  'message',
  'warrantyNote',
  'internalNote',
] as const;

type OfferDraft = Partial<Record<(typeof OFFER_DRAFT_FIELDS)[number], string>>;

export function offerDraftKey(providerId: string, requestId: string): string {
  return `taktick:offer-draft:${providerId}:${requestId}`;
}

/**
 * Rendered inside the offer form. `restore` is true when the page was reached
 * through a refused submit; otherwise any copy left from before is dropped.
 */
export function OfferFormDraft({
  providerId,
  requestId,
  restore,
}: {
  providerId: string;
  requestId: string;
  restore: boolean;
}) {
  const storageKey = offerDraftKey(providerId, requestId);
  const anchor = useRef<HTMLSpanElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    const onSubmit = () => {
      submitted.current = true;
      writeDraft(storageKey, readFields(form));
    };
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [storageKey]);

  // Arriving on the screen: a refusal gets its values back, any other visit
  // starts clean.
  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    if (restore) {
      applyDraft(form, readDraft(storageKey));
    } else {
      removeDraft(storageKey);
    }
  }, [restore, storageKey]);

  // A refusal that re-rendered this form in place rather than mounting a new
  // one — a second refusal with the same code, say. React resets a form after
  // its action settles, so the values go back in after that render, not
  // before it.
  useEffect(() => {
    if (!submitted.current || !restore) return;
    submitted.current = false;
    const form = anchor.current?.closest('form');
    if (form) applyDraft(form, readDraft(storageKey));
  });

  return <span ref={anchor} hidden data-testid="offer-form-draft" />;
}

/** Rendered where the offer already exists: nothing is left to restore. */
export function DiscardOfferDraft({ providerId, requestId }: { providerId: string; requestId: string }) {
  const storageKey = offerDraftKey(providerId, requestId);
  useEffect(() => {
    removeDraft(storageKey);
  }, [storageKey]);

  return null;
}

function readFields(form: HTMLFormElement): OfferDraft {
  const draft: OfferDraft = {};
  for (const name of OFFER_DRAFT_FIELDS) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      draft[name] = field.value;
    }
  }
  return draft;
}

/**
 * Writes each value through the element's own setter and announces it with an
 * `input` event, so a controlled field (the lira input keeps its value in
 * React state) takes the value as if it had been typed, and an uncontrolled one
 * simply shows it.
 */
function applyDraft(form: HTMLFormElement, draft: OfferDraft | null): void {
  if (!draft) return;

  for (const name of OFFER_DRAFT_FIELDS) {
    const value = draft[name];
    const field = form.elements.namedItem(name);
    if (typeof value !== 'string') continue;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) continue;
    if (field.value === value) continue;

    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Storage can be missing or refuse (a private window, a full quota, a blocked
// site): the form then simply behaves as it did before.

function readDraft(key: string): OfferDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const draft: OfferDraft = {};
    for (const name of OFFER_DRAFT_FIELDS) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === 'string') draft[name] = value;
    }
    return draft;
  } catch {
    return null;
  }
}

function writeDraft(key: string, draft: OfferDraft): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // See above.
  }
}

function removeDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // See above.
  }
}

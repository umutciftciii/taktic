/**
 * The cancellation note rule, shared by the form and its action — the API's
 * `SHOWCASE_PLACEMENT_CANCEL_NOTE_MIN_LENGTH`, judged on the trimmed value
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001). Kept out of `actions.ts` because a
 * `'use server'` file may export only async functions.
 */
export const PLACEMENT_CANCEL_NOTE_MIN_LENGTH = 10;

export function isPlacementCancelNoteValid(note: string): boolean {
  return note.trim().length >= PLACEMENT_CANCEL_NOTE_MIN_LENGTH;
}

/**
 * The suspension note rule, shared the same way — the API's
 * `SHOWCASE_PLACEMENT_SUSPEND_NOTE_MIN_LENGTH`, judged trimmed
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001 Paket B). A suspension is not mailed to
 * the provider, so the note is the only record of why.
 */
export const PLACEMENT_SUSPEND_NOTE_MIN_LENGTH = 10;

export function isPlacementSuspendNoteValid(note: string): boolean {
  return note.trim().length >= PLACEMENT_SUSPEND_NOTE_MIN_LENGTH;
}

/**
 * SHOWCASE-ALLOWANCE-004 — the void's internal note, shared by the form and
 * its action: the API's `SHOWCASE_ALLOWANCE_VOID_NOTE_MIN_LENGTH` and the DB
 * CHECK's bounds (10..1000 characters), judged trimmed.
 */
export const ALLOWANCE_VOID_NOTE_MIN_LENGTH = 10;
export const ALLOWANCE_VOID_NOTE_MAX_LENGTH = 1000;

export function isAllowanceVoidNoteValid(note: string): boolean {
  const length = note.trim().length;
  return length >= ALLOWANCE_VOID_NOTE_MIN_LENGTH && length <= ALLOWANCE_VOID_NOTE_MAX_LENGTH;
}

/** The API's `OfferAllowanceVoidReason`, in the order the form offers them. */
export const ALLOWANCE_VOID_REASON_CODES = ['FRAUD', 'ABUSE', 'TERMS_VIOLATION', 'OPERATOR_ERROR', 'OTHER'] as const;

export function isAllowanceVoidReasonCode(value: string): value is (typeof ALLOWANCE_VOID_REASON_CODES)[number] {
  return (ALLOWANCE_VOID_REASON_CODES as readonly string[]).includes(value);
}

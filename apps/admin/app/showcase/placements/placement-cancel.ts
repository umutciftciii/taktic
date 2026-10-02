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

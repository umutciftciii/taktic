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

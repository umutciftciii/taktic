/**
 * What the page found in the draft slot when it rendered the form, carried
 * through the form as a hidden field so the submit action knows whether the
 * request it just created could have consumed the browser's draft.
 *
 * - `restored`      the draft this browser's cookie names was opened into this
 *                   very form: anonymous, or protected for the signed-in
 *                   account. The API consumes it inside the request's own
 *                   transaction, so after a success the cookie names a used
 *                   row and goes.
 * - `wrong-account` the cookie names a draft protected for another account.
 *                   The API leaves that row alone whoever submits, and the
 *                   cookie is the owner's only way back to it: it stays.
 * - `none`          nothing was opened here. The cookie, if there is one at
 *                   all, names a row this form did not show — another form's,
 *                   or a protected one with nobody signed in — and the
 *                   submission cannot have consumed it either: it stays.
 */
export type DraftState = 'restored' | 'wrong-account' | 'none';

export const DRAFT_STATE_FIELD = 'draftState';

export function draftStateFor(input: { restored: boolean; wrongAccount: boolean }): DraftState {
  return input.restored ? 'restored' : input.wrongAccount ? 'wrong-account' : 'none';
}

/** The hidden field as posted; anything unexpected reads as `none` — the cautious answer. */
export function readDraftState(formData: FormData): DraftState {
  const value = formData.get(DRAFT_STATE_FIELD);
  return value === 'restored' || value === 'wrong-account' ? value : 'none';
}

/** Whether a successful submission from this form used the draft up — and so the cookie should go. */
export function draftConsumedBySubmission(state: DraftState): boolean {
  return state === 'restored';
}

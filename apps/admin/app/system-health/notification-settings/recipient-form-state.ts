/**
 * What the recipient form's server action answers (OBS-ALERT-002), kept out of
 * `actions.ts` because a `'use server'` file may export only async functions.
 *
 * A success redirects (the window closes, the list shows the result), so the
 * state only ever carries a refusal: the sentence, the API's code, and the
 * field it is about when there is one, so the form can put it under that field
 * and keep everything that was typed. The message never carries the address.
 */
export type RecipientFormState =
  | { kind: 'idle' }
  | { kind: 'error'; message: string; field: 'address' | 'label' | null; code: string | null; at: number };

export const RECIPIENT_FORM_IDLE: RecipientFormState = { kind: 'idle' };

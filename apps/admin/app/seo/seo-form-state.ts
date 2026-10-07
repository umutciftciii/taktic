/**
 * What an SEO form's server action answers (SEO-004 PR B), kept out of
 * `actions.ts` because a `'use server'` file may export only async functions.
 *
 * A success redirects (the window closes and the list shows the result), so
 * the state only ever carries a refusal: the sentence, and the field it is
 * about when the API named one, so the form can put it under that field and
 * keep everything that was typed.
 */
export type SeoFormState =
  | { kind: 'idle' }
  | { kind: 'error'; message: string; field: string | null; code: string | null; at: number };

export const SEO_FORM_IDLE: SeoFormState = { kind: 'idle' };

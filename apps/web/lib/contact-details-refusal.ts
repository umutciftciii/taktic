/**
 * The one refusal the request form shows *under a field* rather than above
 * the steps: the API found a phone number, e-mail address or link in a
 * free-text field and named which one.
 *
 * Pure, so the mapping from the API's `field` to a place on the form can be
 * tested without rendering anything.
 */
export const CONTACT_DETAILS_IN_TEXT = 'CONTACT_DETAILS_IN_TEXT';

/** The live hint the description field shows while typing. Never blocks. */
export const CONTACT_DETAILS_HINT = 'İletişim bilgisi paylaşılamaz';

/** What the form says under the field when the API refused it. */
export const CONTACT_DETAILS_ERROR =
  'İletişim bilgisi (telefon, e-posta, bağlantı) paylaşılamaz; bilgiler teklif kabul edildiğinde otomatik paylaşılır.';

/** Where on the form the refused text lives. */
export type ContactDetailsTarget =
  | { target: 'description' }
  | { target: 'addressNote' }
  | { target: 'answer'; questionKey: string };

/**
 * Reads the API's `field` into a place on the form, or null for a refusal that
 * is not about contact details, or names a field this form does not have.
 * The latter falls back to the banner above the steps, so a field the API
 * grows later is still reported somewhere.
 */
export function contactDetailsTarget(refusal: {
  code: string;
  field?: string;
}): ContactDetailsTarget | null {
  if (refusal.code !== CONTACT_DETAILS_IN_TEXT || !refusal.field) return null;

  if (refusal.field === 'description') return { target: 'description' };
  if (refusal.field === 'addressNote') return { target: 'addressNote' };

  const answerPrefix = 'answers.';
  if (refusal.field.startsWith(answerPrefix)) {
    const questionKey = refusal.field.slice(answerPrefix.length);
    return questionKey ? { target: 'answer', questionKey } : null;
  }

  return null;
}

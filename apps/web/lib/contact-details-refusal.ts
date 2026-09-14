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
 * grows later — or an answer for a question this form did not render — is
 * still reported somewhere rather than under a control that is not there.
 *
 * `renderedQuestionKeys` is the set of questions on screen; when given, an
 * `answers.<key>` outside it is treated as unplaceable.
 */
export function contactDetailsTarget(
  refusal: { code: string; field?: string },
  renderedQuestionKeys?: readonly string[],
): ContactDetailsTarget | null {
  if (refusal.code !== CONTACT_DETAILS_IN_TEXT || !refusal.field) return null;

  if (refusal.field === 'description') return { target: 'description' };
  if (refusal.field === 'addressNote') return { target: 'addressNote' };

  const answerPrefix = 'answers.';
  if (refusal.field.startsWith(answerPrefix)) {
    const questionKey = refusal.field.slice(answerPrefix.length);
    if (!questionKey) return null;
    if (renderedQuestionKeys && !renderedQuestionKeys.includes(questionKey)) return null;
    return { target: 'answer', questionKey };
  }

  return null;
}

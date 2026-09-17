/**
 * What the marketplace request form says happens next — decided by the
 * instant-publish switch, read from the API on every page load.
 *
 * Both sentences are fixed wording; the switch only chooses between them. The
 * form has no say in what the API does with the request: this is a description
 * of the platform's rule, not a control over it.
 */

export const NEXT_STEPS_TITLE = 'Sırada ne var?';

const REVIEW_SENTENCE =
  'Talebiniz ön incelemeden geçtikten sonra bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';
const INSTANT_SENTENCE =
  'Talebiniz bölgenizdeki onaylı hizmet verenlere iletilir ve 14 gün boyunca teklif alır.';

export function nextStepsNoteText(autoPublishEnabled: boolean): string {
  return autoPublishEnabled ? INSTANT_SENTENCE : REVIEW_SENTENCE;
}

/**
 * Reads `GET /marketplace-publish-policy`'s body as the one boolean it carries.
 *
 * Fail-closed: only the documented shape with a literal `true` is "on". A
 * missing body, a different shape, a string that spells true — all of them are
 * "off", because the review sentence is the promise the platform can keep no
 * matter what the switch says, and the instant sentence is not.
 */
export function readMarketplacePublishPolicy(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return (body as { autoPublishEnabled?: unknown }).autoPublishEnabled === true;
}

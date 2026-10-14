/**
 * SHOWCASE-ALLOWANCE-003 — how a vitrin package's / run's free offer count
 * reads on the provider's screens. 0 is a package with no free offer, and it
 * is said in words rather than as "0 ücretsiz teklif hakkı".
 */
export const NO_FREE_OFFERS_TEXT = 'Ücretsiz teklif hakkı yok';

export function freeOfferCountText(count: number): string {
  return count === 0 ? NO_FREE_OFFERS_TEXT : `${count} ücretsiz teklif hakkı`;
}

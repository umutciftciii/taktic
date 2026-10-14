/**
 * SHOWCASE-ALLOWANCE-003 — how a vitrin package's / run's free offer count
 * reads on the operator's screens. 0 is a package with no free offer, and it
 * is said in words rather than as "0 teklif".
 */
export const NO_FREE_OFFERS_TEXT = 'Ücretsiz teklif hakkı yok';

/** "3 teklif" / "Ücretsiz teklif hakkı yok". */
export function freeOfferCountText(count: number): string {
  return count === 0 ? NO_FREE_OFFERS_TEXT : `${count} teklif`;
}

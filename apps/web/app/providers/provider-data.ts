import { apiFetch, type ProviderCredits } from '../../lib/api';

/**
 * The provider's credit balance for the sidebar box.
 *
 * Read from the same `/providers/:id/credits` route the credits screen uses, so
 * there is one authority for the number. A failure returns null and the box
 * simply does not render — a balance is never guessed or defaulted to zero.
 */
export async function readCreditBalance(providerId: string): Promise<number | null> {
  try {
    const credits = await apiFetch<ProviderCredits>(`/providers/${providerId}/credits`);
    return credits.balance;
  } catch {
    return null;
  }
}

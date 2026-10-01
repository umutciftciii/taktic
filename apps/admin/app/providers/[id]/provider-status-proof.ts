import type { ProviderStatus } from '../../../lib/api';

/**
 * Which confirmation a provider status move needs, as a proof key, or null
 * for a move that goes straight through (ADMIN-DESTRUCTIVE-CONFIRMATION-001).
 *
 * One function for both sides: the status form and the header draw their
 * dialog from it, and `updateProviderStatusAction` demands the same key before
 * it writes — judged against the stored status, not one the form claims.
 *
 * - `provider.status` (Faz 1): a move that stops the business working —
 *   rejecting, suspending, or taking an approved business out of approval by
 *   any other route (APPROVED → DRAFT included).
 * - `provider.approve` (Faz 2): any real move into APPROVED. It mails the
 *   business, resumes its suspended vitrin placements and may fire the
 *   PROVIDER_APPROVED campaign hook.
 * - `provider.draft` (Faz 2): any other move into DRAFT. It voids unused
 *   claim links and, out of REJECTED, clears the rejection reason.
 *
 * Moving to the status a provider already has is not a confirmation: the form
 * refuses it, and an approval re-saved is not a transition (no mail, no hook).
 * PENDING_REVIEW out of DRAFT, REJECTED or SUSPENDED stays direct.
 */
export type ProviderStatusProofKey = 'provider.status' | 'provider.approve' | 'provider.draft';

export function providerStatusProofKey(from: ProviderStatus, to: ProviderStatus): ProviderStatusProofKey | null {
  if (from === to) return null;
  if (to === 'APPROVED') return 'provider.approve';
  if (from === 'APPROVED' || to === 'REJECTED' || to === 'SUSPENDED') return 'provider.status';
  if (to === 'DRAFT') return 'provider.draft';
  return null;
}

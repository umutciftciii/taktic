import { OfferStatus, Prisma, ProviderStatus } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CUSTOMER_ACTIONABLE_OFFER_STATUSES } from './offer-transitions';

/**
 * OFFER-VIEW-001: the one rule for when a customer's look at an offer may be
 * written as `Offer.viewedAt`.
 *
 * `viewedAt` is the whole refund policy (see `calculateRefundEligibility`): a
 * stamp keeps the provider's credit spent, no stamp pays it back once the
 * offer's own refund moment has passed. So a stamp is written only while the
 * look can still decide anything:
 *
 * - **No stamp yet.** The first view is the one on file; a later look never
 *   moves it.
 * - **The offer is still a live choice** — SUBMITTED, VIEWED or SHORTLISTED.
 *   A rival the customer's acceptance already closed (REJECTED), a withdrawn,
 *   expired or cancelled offer: opening it afterwards is reading history, and
 *   "rejected without being viewed" is settled at the rejection, not by a
 *   later visit (A-1).
 * - **The refund moment has not arrived.** Once `unviewedRefundEligibleAt` is
 *   past, the promise has matured; the hourly worker merely has not paid it
 *   yet, and a look in that gap must not take it back (A-2). An offer with no
 *   schedule (from before the policy) refunds nothing either way and is
 *   stamped as before.
 * - **The provider is approved** (PROVIDER-STATUS-001). A live offer of a
 *   provider that is not is hidden from the customer, so nothing the customer
 *   does can be a look at it — not even a list report from a screen that was
 *   open when the provider was suspended. It keeps the stamp it had, or stays
 *   unstamped and is paid back by the unviewed-offer rule as before.
 *
 * Every writer — the detail open, the list/compare impression and the
 * customer's shortlist/reject — puts this in its UPDATE's own `where`, so it
 * is the row as the database holds it at write time that decides.
 *
 * The customer's *acceptance* stamps without the time clause, on purpose: an
 * accepted offer is the outcome the credit bought, and a refunded offer is
 * charged again on acceptance (`chargeRefundedOfferOnAcceptInTransaction`).
 * Leaving an accepted offer unstamped after its refund moment would let the
 * worker pay back the credit of the very match it produced.
 */
export function viewStampableWhere(now: Date) {
  return {
    viewedAt: null,
    status: { in: [...CUSTOMER_ACTIONABLE_OFFER_STATUSES] },
    provider: { status: ProviderStatus.APPROVED },
    OR: [{ unviewedRefundEligibleAt: null }, { unviewedRefundEligibleAt: { gt: now } }],
  } satisfies Prisma.OfferWhereInput;
}

/** The most offers one impression report may name. */
export const OFFER_IMPRESSIONS_MAX = 50;

/**
 * Stamps the offers this customer actually looked at and moves the untouched
 * ones from SUBMITTED to VIEWED, in one transaction.
 *
 * Both writes are conditional, so the call is idempotent and safe to race: of
 * any number of simultaneous reports for one offer exactly one row-write
 * finds `viewedAt IS NULL`, and the status move only ever follows a stamp that
 * is on file. `scope` narrows the rows to the caller's request (and round), so
 * an id from elsewhere matches nothing rather than being an error to probe.
 *
 * Returns how many offers received their first stamp.
 */
export async function stampCustomerViews(
  prisma: PrismaService,
  scope: Prisma.OfferWhereInput,
  now: Date,
): Promise<number> {
  const [stamped] = await prisma.$transaction([
    prisma.offer.updateMany({
      where: { ...scope, ...viewStampableWhere(now) },
      data: { viewedAt: now },
    }),
    prisma.offer.updateMany({
      // An approved provider's only, like the stamp: a hidden offer's row is not written.
      where: { ...scope, status: OfferStatus.SUBMITTED, viewedAt: { not: null }, provider: { status: ProviderStatus.APPROVED } },
      data: { status: OfferStatus.VIEWED },
    }),
  ]);

  return stamped.count;
}
